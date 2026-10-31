'use strict';

/**
 * Login maps an application user to their own Fabric identity in the wallet.
 * Passwords are verified against an scrypt hash written at enrollment time;
 * sessions are short-lived HS256 JWTs.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('./config');
const { loadIdentity } = require('./fabric');

const secret = process.env.HC_JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.HC_JWT_SECRET) {
    console.warn('[auth] HC_JWT_SECRET not set; using a random secret (sessions end when the server restarts)');
}

function verifyPassword(username, password) {
    const file = path.join(config.walletDir, username, 'password.hash');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(username) || !fs.existsSync(file)) {
        // Burn comparable time so unknown users are not distinguishable by timing.
        crypto.scryptSync(String(password), 'unknown-user', 32);
        return false;
    }
    const [scheme, saltHex, hashHex] = fs.readFileSync(file, 'utf8').trim().split('$');
    if (scheme !== 'scrypt') {
        return false;
    }
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(expected, actual);
}

function login(username, password) {
    if (!verifyPassword(username, password)) {
        return null;
    }
    const id = loadIdentity(username);
    const user = { username, role: id.role, hcId: id.hcId, mspId: id.mspId, displayName: id.displayName };
    return { token: jwt.sign(user, secret, { expiresIn: config.jwtTtl, subject: username }), user };
}

function requireAuth(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    try {
        req.user = jwt.verify(token, secret);
        next();
    } catch (e) {
        res.status(401).json({ error: 'Login required' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => (roles.includes(req.user.role)
        ? next()
        : res.status(403).json({ error: `Only ${roles.join('/')} may do this` }));
}

module.exports = { login, requireAuth, requireRole };
