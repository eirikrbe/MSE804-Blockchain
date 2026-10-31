'use strict';

const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const path = require('path');

const config = require('./config');
const fabric = require('./fabric');
const { login, requireAuth, requireRole } = require('./auth');
const { Vault } = require('./vault');
const { merkleRoot, merkleProof, verifyProof } = require('./merkle');

const vault = new Vault(config.dataDir, process.env.HC_MASTER_KEY);
const app = express();

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Express 4 does not forward rejected promises to the error handler.
const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const u = req => req.user.username;

// ---------------------------------------------------------------- auth

app.post('/api/login', rateLimit({ windowMs: 60_000, limit: 10 }), route(async (req, res) => {
    const session = login(String(req.body.username || ''), String(req.body.password || ''));
    if (!session) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }
    // First login: register the participant on the ledger from the certificate.
    if (session.user.role !== 'wearable') {
        try {
            await fabric.evaluate(session.user.username, 'getMyProfile');
        } catch (err) {
            if (err.status !== 404) {
                throw err;
            }
            await fabric.submit(session.user.username, 'registerParticipant', session.user.displayName);
        }
    }
    res.json(session);
}));

app.use('/api', requireAuth);

app.get('/api/me', route(async (req, res) => {
    res.json({ session: req.user, profile: await fabric.evaluate(u(req), 'getMyProfile') });
}));

app.get('/api/providers', route(async (req, res) => {
    res.json(await fabric.evaluate(u(req), 'listProviders', req.query.role || ''));
}));

// ---------------------------------------------------------------- consent

app.get('/api/consents', route(async (req, res) => {
    res.json(await fabric.evaluate(u(req), 'listMyConsents'));
}));

app.post('/api/consents', requireRole('patient'), route(async (req, res) => {
    const { providerId, scopes, expiresAt } = req.body;
    res.status(201).json(await fabric.submit(u(req), 'grantAccess', providerId, JSON.stringify(scopes || []), expiresAt));
}));

app.delete('/api/consents/:providerId', requireRole('patient'), route(async (req, res) => {
    res.json(await fabric.submit(u(req), 'revokeAccess', req.params.providerId));
}));

app.post('/api/emergency', requireRole('clinician'), route(async (req, res) => {
    res.status(201).json(await fabric.submit(u(req), 'emergencyAccess', req.body.patientId, req.body.reason));
}));

app.get('/api/access-log', requireRole('patient'), route(async (req, res) => {
    res.json(await fabric.evaluate(u(req), 'getAccessLog'));
}));

// ---------------------------------------------------------------- records

app.get('/api/patients/:patientId/records', route(async (req, res) => {
    res.json(await fabric.evaluate(u(req), 'listRecords', req.params.patientId));
}));

app.post('/api/patients/:patientId/records', requireRole('clinician'), route(async (req, res) => {
    const { title, content } = req.body;
    if (!content || typeof content !== 'object') {
        return res.status(400).json({ error: 'content (object) is required' });
    }
    const { storageUri, contentHash } = vault.put(req.params.patientId, 'records', content);
    res.status(201).json(await fabric.submit(u(req), 'createRecord', req.params.patientId, title || 'Consultation', contentHash, storageUri));
}));

app.post('/api/patients/:patientId/lab-results', requireRole('lab'), route(async (req, res) => {
    const { testName, content } = req.body;
    if (!content || typeof content !== 'object') {
        return res.status(400).json({ error: 'content (object) is required' });
    }
    const { storageUri, contentHash } = vault.put(req.params.patientId, 'lab-results', content);
    res.status(201).json(await fabric.submit(u(req), 'addLabResult', req.params.patientId, testName || 'Lab result', contentHash, storageUri));
}));

/** Reading content always goes through accessRecord, so it is logged on-chain first. */
app.get('/api/records/:recordId', route(async (req, res) => {
    const record = await fabric.submit(u(req), 'accessRecord', req.params.recordId, req.query.purpose || 'view');
    const content = vault.get(record.patientId, record.storageUri, record.contentHash);
    res.json({ record, content, integrity: 'verified against on-chain SHA-256' });
}));

app.put('/api/records/:recordId', requireRole('clinician'), route(async (req, res) => {
    if (!req.body.content || typeof req.body.content !== 'object') {
        return res.status(400).json({ error: 'content (object) is required' });
    }
    const current = await fabric.submit(u(req), 'accessRecord', req.params.recordId, 'update');
    const { storageUri, contentHash } = vault.put(current.patientId, 'records', req.body.content);
    res.json(await fabric.submit(u(req), 'updateRecord', req.params.recordId, contentHash, storageUri));
}));

app.get('/api/records/:recordId/history', route(async (req, res) => {
    res.json(await fabric.evaluate(u(req), 'getRecordHistory', req.params.recordId));
}));

// ---------------------------------------------------------------- personal details

app.put('/api/me/details', requireRole('patient'), route(async (req, res) => {
    res.json(await fabric.submitPrivate(u(req), 'setMyDetails', { details: req.body }));
}));

app.get('/api/patients/:patientId/details', route(async (req, res) => {
    res.json(await fabric.evaluate(u(req), 'getPatientDetails', req.params.patientId));
}));

/** Right to erasure: purge private details on every peer and crypto-shred off-chain data. */
app.delete('/api/me/details', requireRole('patient'), route(async (req, res) => {
    const result = await fabric.submit(u(req), 'eraseMyDetails');
    result.offChainDataKeyDestroyed = vault.shred(req.user.hcId);
    res.json(result);
}));

// ---------------------------------------------------------------- wearables

app.post('/api/wearables', requireRole('patient'), route(async (req, res) => {
    res.status(201).json(await fabric.submit(u(req), 'registerWearable', req.body.deviceId, req.body.name || ''));
}));

app.delete('/api/wearables/:deviceId', requireRole('patient'), route(async (req, res) => {
    res.json(await fabric.submit(u(req), 'unpairWearable', req.params.deviceId));
}));

/**
 * A device posts a window of raw readings plus the Merkle root it computed.
 * The gateway re-computes the root, stores the readings encrypted off-chain
 * and records one batch transaction on the ledger.
 */
app.post('/api/wearables/batch', requireRole('wearable'), route(async (req, res) => {
    const readings = req.body.readings;
    if (!Array.isArray(readings) || readings.length === 0 || readings.length > 10000) {
        return res.status(400).json({ error: 'readings must be a non-empty array (max 10000)' });
    }
    const root = merkleRoot(readings);
    if (req.body.merkleRoot && req.body.merkleRoot !== root) {
        return res.status(400).json({ error: 'merkleRoot does not match the readings' });
    }
    const device = await fabric.evaluate(u(req), 'getMyProfile');
    const hr = readings.map(r => Number(r.heartRate));
    const times = readings.map(r => Date.parse(r.ts)).sort((a, b) => a - b);
    const last = readings[readings.length - 1];
    const { storageUri, contentHash } = vault.put(device.patientId, 'wearable', readings);
    const batch = {
        windowStart: new Date(times[0]).toISOString(),
        windowEnd: new Date(times[times.length - 1]).toISOString(),
        count: readings.length,
        merkleRoot: root,
        stats: {
            heartRateMin: Math.min(...hr),
            heartRateMax: Math.max(...hr),
            heartRateAvg: Math.round((hr.reduce((a, b) => a + b, 0) / hr.length) * 10) / 10,
            steps: Number(last.steps) || 0,
            calories: Number(last.calories) || 0,
        },
        storageUri,
        contentHash,
    };
    res.status(201).json(await fabric.submit(u(req), 'submitWearableBatch', JSON.stringify(batch)));
}));

app.get('/api/patients/:patientId/wearables', route(async (req, res) => {
    res.json(await fabric.evaluate(u(req), 'listWearableBatches', req.params.patientId));
}));

/** Prove that one raw reading belongs to an on-chain batch. */
app.get('/api/patients/:patientId/wearables/:batchId/proof/:index', route(async (req, res) => {
    const batches = await fabric.evaluate(u(req), 'listWearableBatches', req.params.patientId);
    const batch = batches.find(b => b.batchId === req.params.batchId);
    if (!batch || !batch.storageUri) {
        return res.status(404).json({ error: 'Batch not found' });
    }
    const readings = vault.get(batch.patientId, batch.storageUri, batch.contentHash);
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= readings.length) {
        return res.status(400).json({ error: `index must be between 0 and ${readings.length - 1}` });
    }
    const proof = merkleProof(readings, index);
    res.json({ reading: readings[index], proof, merkleRoot: batch.merkleRoot, valid: verifyProof(readings[index], proof, batch.merkleRoot) });
}));

// ---------------------------------------------------------------- errors

app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) {
        console.error(err);
    }
    res.status(status).json({ error: err.message });
});

module.exports = app;
