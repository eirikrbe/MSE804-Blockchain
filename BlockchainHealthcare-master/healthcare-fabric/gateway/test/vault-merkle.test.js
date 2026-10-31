'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Vault } = require('../src/vault');
const { merkleRoot, merkleProof, verifyProof } = require('../src/merkle');

describe('Vault (encrypted off-chain storage)', () => {
    let dir;
    let vault;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-vault-'));
        vault = new Vault(dir, crypto.randomBytes(32).toString('base64'));
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('round-trips a document and stores no plaintext', () => {
        const doc = { diagnosis: 'asthma', allergies: 'penicillin' };
        const { storageUri, contentHash } = vault.put('patient-alice', 'records', doc);
        expect(contentHash).to.match(/^[a-f0-9]{64}$/);
        expect(vault.get('patient-alice', storageUri, contentHash)).to.deep.equal(doc);
        const raw = fs.readdirSync(path.join(dir, 'offchain')).map(f => fs.readFileSync(path.join(dir, 'offchain', f), 'latin1')).join('');
        expect(raw).to.not.include('penicillin');
    });

    it('detects tampering via the on-chain hash', () => {
        const { storageUri, contentHash } = vault.put('patient-alice', 'records', { a: 1 });
        const file = path.join(dir, 'offchain', fs.readdirSync(path.join(dir, 'offchain'))[0]);
        const blob = fs.readFileSync(file);
        blob[blob.length - 1] ^= 0xff;
        fs.writeFileSync(file, blob);
        expect(() => vault.get('patient-alice', storageUri, contentHash)).to.throw(/Integrity check failed/);
    });

    it('a blob cannot be decrypted as another patient\'s record', () => {
        const { storageUri, contentHash } = vault.put('patient-alice', 'records', { a: 1 });
        vault.put('patient-bob', 'records', { b: 1 });
        expect(() => vault.get('patient-bob', storageUri, contentHash)).to.throw();
    });

    it('crypto-shredding makes existing records unreadable', () => {
        const { storageUri, contentHash } = vault.put('patient-alice', 'records', { a: 1 });
        expect(vault.shred('patient-alice')).to.equal(true);
        expect(() => vault.get('patient-alice', storageUri, contentHash)).to.throw(/erased/);
    });

    it('a different master key cannot unwrap the data keys', () => {
        const { storageUri, contentHash } = vault.put('patient-alice', 'records', { a: 1 });
        const other = new Vault(dir, crypto.randomBytes(32).toString('base64'));
        expect(() => other.get('patient-alice', storageUri, contentHash)).to.throw();
    });

    it('rejects path traversal in ids and URIs', () => {
        expect(() => vault.put('../evil', 'records', {})).to.throw(/Invalid patient id/);
        expect(() => vault.get('patient-alice', 'offchain://records/../../etc/passwd', 'x')).to.throw(/Invalid storage URI/);
    });
});

describe('Merkle batches', () => {
    const readings = Array.from({ length: 7 }, (_, i) => ({ ts: `2026-10-09T10:00:0${i}Z`, heartRate: 60 + i, steps: i * 10, calories: i }));

    it('is independent of key order', () => {
        const shuffled = readings.map(r => ({ calories: r.calories, steps: r.steps, heartRate: r.heartRate, ts: r.ts }));
        expect(merkleRoot(shuffled)).to.equal(merkleRoot(readings));
    });

    it('proves membership of every reading (odd-sized tree)', () => {
        const root = merkleRoot(readings);
        readings.forEach((r, i) => expect(verifyProof(r, merkleProof(readings, i), root)).to.equal(true));
    });

    it('rejects a modified reading', () => {
        const root = merkleRoot(readings);
        const proof = merkleProof(readings, 3);
        expect(verifyProof(Object.assign({}, readings[3], { heartRate: 200 }), proof, root)).to.equal(false);
    });

    it('changes when any reading changes', () => {
        const changed = readings.slice();
        changed[6] = Object.assign({}, changed[6], { steps: 999 });
        expect(merkleRoot(changed)).to.not.equal(merkleRoot(readings));
    });
});
