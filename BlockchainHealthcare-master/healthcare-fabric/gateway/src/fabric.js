'use strict';

/**
 * One Fabric Gateway connection per logged-in user, signing with that user's
 * own enrolled key. The chaincode therefore sees the real caller identity
 * (MSP + hc.role + hc.id); the REST layer never acts on someone's behalf.
 */

const grpc = require('@grpc/grpc-js');
const { connect, hash, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('./config');

const clients = new Map();   // mspId -> grpc.Client
const gateways = new Map();  // username -> { gateway, contract }
const utf8 = new TextDecoder();

function grpcClient(mspId) {
    if (!clients.has(mspId)) {
        const peer = config.peers[mspId];
        if (!peer) {
            throw new Error(`No peer configured for ${mspId}`);
        }
        const tls = grpc.credentials.createSsl(fs.readFileSync(peer.tlsCert));
        clients.set(mspId, new grpc.Client(peer.endpoint, tls, { 'grpc.ssl_target_name_override': peer.hostAlias }));
    }
    return clients.get(mspId);
}

function loadIdentity(username) {
    const dir = path.join(config.walletDir, username);
    const file = path.join(dir, 'identity.json');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(username) || !fs.existsSync(file)) {
        return null;
    }
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keyDir = path.join(dir, meta.keyDir);
    const keyFile = fs.readdirSync(keyDir).find(f => f.endsWith('_sk'));
    return Object.assign(meta, {
        dir,
        cert: fs.readFileSync(path.join(dir, meta.certPath)),
        key: fs.readFileSync(path.join(keyDir, keyFile)),
    });
}

function contractFor(username) {
    if (!gateways.has(username)) {
        const id = loadIdentity(username);
        if (!id) {
            throw new Error(`No wallet identity for ${username}`);
        }
        const gateway = connect({
            client: grpcClient(id.mspId),
            identity: { mspId: id.mspId, credentials: id.cert },
            signer: signers.newPrivateKeySigner(crypto.createPrivateKey(id.key)),
            hash: hash.SHA256,
            evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
            endorseOptions: () => ({ deadline: Date.now() + 15000 }),
            submitOptions: () => ({ deadline: Date.now() + 5000 }),
            commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
        });
        const contract = gateway.getNetwork(config.channel).getContract(config.chaincode);
        gateways.set(username, { gateway, contract });
    }
    return gateways.get(username).contract;
}

function parse(bytes) {
    const text = utf8.decode(bytes);
    return text ? JSON.parse(text) : null;
}

/** Turn a Fabric Gateway error into {status, message} using the chaincode's own message. */
function toHttpError(err) {
    const details = (err.details || []).map(d => d.message).filter(Boolean);
    let message = details[0] || err.message || String(err);
    message = message.replace(/^.*?chaincode response \d+, /, '').replace(/^Error: /, '');
    let status = 500;
    if (/no active|Only |does not match|cannot be granted|not paired|belongs to|cannot self-register/.test(message)) {
        status = 403;
    } else if (/does not exist|No details|not registered/.test(message)) {
        status = 404;
    } else if (/already|must be|required|Invalid|at most|At least/.test(message)) {
        status = 400;
    }
    return Object.assign(new Error(message), { status });
}

async function evaluate(username, fn, ...args) {
    try {
        return parse(await contractFor(username).evaluateTransaction(fn, ...args.map(String)));
    } catch (err) {
        throw toHttpError(err);
    }
}

async function submit(username, fn, ...args) {
    try {
        return parse(await contractFor(username).submitTransaction(fn, ...args.map(String)));
    } catch (err) {
        throw toHttpError(err);
    }
}

/** Submit with transient (private) data that never appears in a block. */
async function submitPrivate(username, fn, transientData, ...args) {
    try {
        const transient = {};
        for (const [k, v] of Object.entries(transientData)) {
            transient[k] = Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));
        }
        return parse(await contractFor(username).submit(fn, { arguments: args.map(String), transientData: transient }));
    } catch (err) {
        throw toHttpError(err);
    }
}

function close() {
    for (const { gateway } of gateways.values()) {
        gateway.close();
    }
    for (const client of clients.values()) {
        client.close();
    }
}

module.exports = { loadIdentity, evaluate, submit, submitPrivate, close };
