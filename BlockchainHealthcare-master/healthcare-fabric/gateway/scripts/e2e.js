'use strict';

/**
 * End-to-end check against a running gateway + Fabric network.
 *   1. ../network/network.sh up && ../network/network.sh enroll
 *   2. npm start            (in another terminal)
 *   3. npm run e2e
 * Uses the passwords written to wallet/credentials.txt by `network.sh enroll`.
 * Run it against a fresh network: it registers wearables and consents.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BASE = process.env.GATEWAY_URL || 'http://localhost:3000';
const creds = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', 'wallet', 'credentials.txt'), 'utf8')
    .trim().split('\n').map(l => l.trim().split(/\s+/)).map(([u, , p]) => [u, p]));

const tokens = {};
let passed = 0;

async function call(user, method, url, body) {
    const res = await fetch(BASE + url, {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, tokens[user] ? { Authorization: `Bearer ${tokens[user]}` } : {}),
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

async function ok(user, method, url, body) {
    const r = await call(user, method, url, body);
    assert.ok(r.status < 300, `${user} ${method} ${url} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
}

async function denied(user, method, url, body, status = 403) {
    const r = await call(user, method, url, body);
    assert.strictEqual(r.status, status, `${user} ${method} ${url} expected ${status}, got ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
}

function check(name) {
    passed += 1;
    console.log(`  ✔ ${name}`);
}

const days = n => new Date(Date.now() + n * 864e5).toISOString();

(async () => {
    for (const user of Object.keys(creds)) {
        tokens[user] = (await ok(null, 'POST', '/api/login', { username: user, password: creds[user] })).token;
    }
    await denied(null, 'POST', '/api/login', { username: 'alice', password: 'wrong' }, 401);
    check('every user logs in with their own Fabric identity; wrong password rejected');

    // Consent: grant two clinicians, both stay.
    await ok('alice', 'POST', '/api/consents', { providerId: 'clinician-a', scopes: ['records:read', 'records:write', 'details:read'], expiresAt: days(30) });
    await ok('alice', 'POST', '/api/consents', { providerId: 'clinician-b', scopes: ['records:read'], expiresAt: days(30) });
    let consents = await ok('alice', 'GET', '/api/consents');
    assert.deepStrictEqual(consents.filter(c => c.status === 'active').map(c => c.providerId).sort(), ['clinician-a', 'clinician-b']);
    check('granting Dr B keeps Dr A on the list (slide 4 bug fixed)');

    // Records: encrypted off-chain, hash on-chain.
    const content = { medicalHistory: 'asthma', allergies: 'penicillin', currentMedication: 'salbutamol' };
    const record = await ok('drA', 'POST', '/api/patients/patient-alice/records', { title: 'First visit', content });
    assert.match(record.contentHash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(record).includes('penicillin'));
    check('Dr A writes a record: ledger holds only hash + pointer, content is AES-256-GCM off-chain');

    const opened = await ok('drB', 'GET', `/api/records/${record.recordId}?purpose=second%20opinion`);
    assert.deepStrictEqual(opened.content, content);
    check('Dr B (read consent) decrypts it after the on-chain hash check');

    await ok('alice', 'DELETE', '/api/consents/clinician-b');
    await denied('drB', 'GET', `/api/records/${record.recordId}`);
    await ok('drA', 'GET', `/api/records/${record.recordId}?purpose=follow-up`);
    check('revoking Dr B removes only Dr B; Dr A keeps access');

    await denied('bob', 'GET', `/api/records/${record.recordId}`);
    await denied('drB', 'POST', '/api/patients/patient-alice/records', { title: 'x', content: { a: 1 } });
    await denied('drA', 'POST', '/api/consents', { providerId: 'clinician-a', scopes: ['records:read'], expiresAt: days(1) });
    check('other patients, unauthorised clinicians and self-granting are all rejected');

    await ok('drA', 'PUT', `/api/records/${record.recordId}`, { content: Object.assign({}, content, { allergies: 'none' }) });
    const history = await ok('alice', 'GET', `/api/records/${record.recordId}/history`);
    assert.deepStrictEqual(history.map(h => h.value.version), [1, 2]);
    check('updates are versioned; full history comes from the ledger');

    // Labs
    await denied('labA', 'POST', '/api/patients/patient-alice/lab-results', { testName: 'CBC', content: { hb: 13.5 } });
    await ok('alice', 'POST', '/api/consents', { providerId: 'lab-a', scopes: ['lab:write'], expiresAt: days(7) });
    await ok('labA', 'POST', '/api/patients/patient-alice/lab-results', { testName: 'CBC', content: { hb: 13.5 } });
    check('labs upload results only with lab:write consent');

    // Emergency
    await ok('drB', 'POST', '/api/emergency', { patientId: 'patient-alice', reason: 'Patient unconscious in ER' });
    await ok('drB', 'GET', `/api/records/${record.recordId}?purpose=ER%20treatment`);
    const log = await ok('alice', 'GET', '/api/access-log');
    assert.ok(log.some(l => l.accessorId === 'clinician-b' && l.via === 'emergency' && l.action === 'read-record'));
    assert.ok(log.some(l => l.accessorId === 'clinician-a' && l.via === 'consent'));
    await denied('drA', 'GET', '/api/access-log');
    check('break-glass access works and every read shows up in the patient\'s access log');

    // Wearables
    await ok('alice', 'POST', '/api/wearables', { deviceId: 'band-alice', name: 'Alice band' });
    const readings = Array.from({ length: 20 }, (_, i) => ({ ts: new Date(Date.now() - (20 - i) * 3000).toISOString(), heartRate: 60 + (i % 9) * 5, steps: i * 25, calories: i }));
    const batch = await ok('band', 'POST', '/api/wearables/batch', { readings });
    assert.strictEqual(batch.patientId, 'patient-alice');
    assert.strictEqual(batch.count, 20);
    check('the paired band submits 20 readings as ONE transaction (Merkle root on-chain)');

    await denied('trainer', 'GET', '/api/patients/patient-alice/wearables');
    await ok('alice', 'POST', '/api/consents', { providerId: 'trainer-t', scopes: ['wearable:read'], expiresAt: days(7) });
    const batches = await ok('trainer', 'GET', '/api/patients/patient-alice/wearables');
    const proof = await ok('trainer', 'GET', `/api/patients/patient-alice/wearables/${batches[0].batchId}/proof/7`);
    assert.strictEqual(proof.valid, true);
    await denied('trainer', 'GET', `/api/records/${record.recordId}`);
    check('trainer sees wearable summaries (and a valid Merkle proof) but never medical records');

    // Private details + erasure
    await ok('alice', 'PUT', '/api/me/details', { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com' });
    assert.strictEqual((await ok('drA', 'GET', '/api/patients/patient-alice/details')).email, 'alice@example.com');
    await denied('labA', 'GET', '/api/patients/patient-alice/details');
    check('personal details live in a private data collection, readable only with details:read');

    // Tamper detection: corrupt the current off-chain blob, expect 409, restore it.
    const current = (await ok('alice', 'GET', '/api/patients/patient-alice/records')).find(r => r.recordId === record.recordId);
    const [, , kind, uuid] = current.storageUri.split('/');
    const blobFile = path.join(__dirname, '..', 'data', 'offchain', `${kind}-${uuid}.bin`);
    const original = fs.readFileSync(blobFile);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] ^= 0xff;
    fs.writeFileSync(blobFile, tampered);
    await denied('alice', 'GET', `/api/records/${record.recordId}`, undefined, 409);
    fs.writeFileSync(blobFile, original);
    check('tampering with an off-chain blob is detected via the on-chain hash');

    await ok('alice', 'DELETE', '/api/me/details');
    await denied('drA', 'GET', '/api/patients/patient-alice/details', undefined, 404);
    await denied('alice', 'GET', `/api/records/${record.recordId}`, undefined, 410);
    check('right to erasure: details purged on every peer, off-chain data key crypto-shredded');

    console.log(`\n${passed} end-to-end checks passed against ${BASE}`);
})().catch(err => {
    console.error(`\n✘ ${err.message}`);
    process.exit(1);
});
