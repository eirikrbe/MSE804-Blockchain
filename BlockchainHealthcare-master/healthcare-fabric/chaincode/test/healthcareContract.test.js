'use strict';

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;
const crypto = require('crypto');

const HealthcareContract = require('../lib/healthcareContract');
const { Ledger, contextFor } = require('./mockContext');

const HOSPITAL = 'Org1MSP';
const LAB_ORG = 'Org2MSP';

const users = {
    alice: { mspId: HOSPITAL, role: 'patient', id: 'patient-alice' },
    bob: { mspId: HOSPITAL, role: 'patient', id: 'patient-bob' },
    drA: { mspId: HOSPITAL, role: 'clinician', id: 'clinician-a' },
    drB: { mspId: HOSPITAL, role: 'clinician', id: 'clinician-b' },
    labA: { mspId: LAB_ORG, role: 'lab', id: 'lab-a' },
    labB: { mspId: LAB_ORG, role: 'lab', id: 'lab-b' },
    trainer: { mspId: LAB_ORG, role: 'trainer', id: 'trainer-t' },
    aliceBand: { mspId: HOSPITAL, role: 'wearable', id: 'band-alice' },
};

const DAY = 24 * 60 * 60 * 1000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

describe('HealthcareContract', () => {
    let ledger;
    let contract;

    const call = (user, fn, ...args) => contract[fn](contextFor(ledger, users[user]), ...args);
    const inDays = d => new Date(ledger.time + d * DAY).toISOString();
    const grant = (patient, provider, scopes, days = 30) =>
        call(patient, 'grantAccess', users[provider].id, JSON.stringify(scopes), inDays(days));

    beforeEach(async () => {
        ledger = new Ledger();
        contract = new HealthcareContract();
        for (const u of ['alice', 'bob', 'drA', 'drB', 'labA', 'labB', 'trainer']) {
            await call(u, 'registerParticipant', u);
        }
        await call('alice', 'registerWearable', users.aliceBand.id, 'Alice band');
    });

    describe('identity', () => {
        it('takes role and id from the certificate, not from arguments', async () => {
            const p = await call('alice', 'getMyProfile');
            expect(p).to.include({ id: 'patient-alice', role: 'patient', mspId: HOSPITAL });
        });

        it('rejects a certificate whose MSP differs from the registered one', async () => {
            const forged = { mspId: LAB_ORG, role: 'patient', id: 'patient-alice' };
            await expect(contract.getMyProfile(contextFor(ledger, forged))).to.be.rejectedWith(/does not match/);
        });

        it('rejects a certificate whose role differs from the registered one', async () => {
            const forged = { mspId: HOSPITAL, role: 'clinician', id: 'patient-alice' };
            await expect(contract.getMyProfile(contextFor(ledger, forged))).to.be.rejectedWith(/does not match/);
        });

        it('cannot register twice', async () => {
            await expect(call('alice', 'registerParticipant', 'again')).to.be.rejectedWith(/already registered/);
        });

        it('wearables cannot self-register', async () => {
            await expect(call('aliceBand', 'registerParticipant', 'x')).to.be.rejectedWith(/cannot self-register/);
        });
    });

    describe('consent (fixes the broken grant/revoke logic)', () => {
        it('granting a second clinician keeps the first', async () => {
            await grant('alice', 'drA', ['records:read']);
            await grant('alice', 'drB', ['records:read']);
            const consents = await call('alice', 'listMyConsents');
            expect(consents.filter(c => c.status === 'active').map(c => c.providerId).sort())
                .to.deep.equal(['clinician-a', 'clinician-b']);
        });

        it('revoking one clinician keeps the others', async () => {
            await grant('alice', 'drA', ['records:read']);
            await grant('alice', 'drB', ['records:read']);
            await call('alice', 'revokeAccess', 'clinician-a');
            const consents = await call('alice', 'listMyConsents');
            expect(consents.find(c => c.providerId === 'clinician-a').status).to.equal('revoked');
            expect(consents.find(c => c.providerId === 'clinician-b').status).to.equal('active');
        });

        it('revoking one lab keeps the other lab', async () => {
            await grant('alice', 'labA', ['records:read']);
            await grant('alice', 'labB', ['records:read']);
            await call('alice', 'revokeAccess', 'lab-a');
            await expect(call('labA', 'listRecords', 'patient-alice')).to.be.rejectedWith(/no active/);
            expect(await call('labB', 'listRecords', 'patient-alice')).to.deep.equal([]);
        });

        it('providers see the consents they received from several patients', async () => {
            await grant('alice', 'drA', ['records:read']);
            await grant('bob', 'drA', ['records:read']);
            const received = await call('drA', 'listMyConsents');
            expect(received.map(c => c.patientId).sort()).to.deep.equal(['patient-alice', 'patient-bob']);
        });

        it('only patients can grant, and only for themselves', async () => {
            await expect(call('drA', 'grantAccess', 'clinician-a', '["records:read"]', inDays(10)))
                .to.be.rejectedWith(/Only patient/);
        });

        it('enforces least privilege per provider role', async () => {
            await expect(grant('alice', 'trainer', ['records:read'])).to.be.rejectedWith(/cannot be granted/);
            await expect(grant('alice', 'labA', ['records:write'])).to.be.rejectedWith(/cannot be granted/);
        });

        it('requires a future expiry of at most one year', async () => {
            await expect(grant('alice', 'drA', ['records:read'], -1)).to.be.rejectedWith(/future/);
            await expect(grant('alice', 'drA', ['records:read'], 400)).to.be.rejectedWith(/at most one year/);
        });

        it('access ends automatically when consent expires', async () => {
            await grant('alice', 'drA', ['records:read'], 2);
            expect(await call('drA', 'listRecords', 'patient-alice')).to.deep.equal([]);
            ledger.advance(3 * DAY);
            await expect(call('drA', 'listRecords', 'patient-alice')).to.be.rejectedWith(/no active/);
        });

        it('emits an event for every consent change', async () => {
            const ctx = contextFor(ledger, users.alice);
            await contract.grantAccess(ctx, 'clinician-a', '["records:read"]', inDays(5));
            expect(ctx.stub.events[0].name).to.equal('ConsentGranted');
        });
    });

    describe('medical records (off-chain content, on-chain hash)', () => {
        const hash = sha('ciphertext-1');

        it('an unauthorised clinician cannot create a record', async () => {
            await expect(call('drA', 'createRecord', 'patient-alice', 'Visit', hash, 'offchain://r1'))
                .to.be.rejectedWith(/no active 'records:write'/);
        });

        it('a read-only clinician cannot write', async () => {
            await grant('alice', 'drA', ['records:read']);
            await expect(call('drA', 'createRecord', 'patient-alice', 'Visit', hash, 'offchain://r1'))
                .to.be.rejectedWith(/records:write/);
        });

        it('record ID is the transaction ID (deterministic on every peer)', async () => {
            await grant('alice', 'drA', ['records:read', 'records:write']);
            const ctx = contextFor(ledger, users.drA);
            const r = await contract.createRecord(ctx, 'patient-alice', 'Visit', hash, 'offchain://r1');
            expect(r.recordId).to.equal(ctx.stub.getTxID());
            expect(r).to.include({ version: 1, author: 'clinician-a', contentHash: hash });
        });

        it('rejects anything that is not a SHA-256 digest (no plaintext on chain)', async () => {
            await grant('alice', 'drA', ['records:write']);
            await expect(call('drA', 'createRecord', 'patient-alice', 'Visit', 'asthma, penicillin', 'x'))
                .to.be.rejectedWith(/SHA-256/);
        });

        it('updates bump the version and keep history', async () => {
            await grant('alice', 'drA', ['records:read', 'records:write']);
            await grant('alice', 'drB', ['records:read', 'records:write']);
            const r = await call('drA', 'createRecord', 'patient-alice', 'Visit', hash, 'offchain://r1');
            const u = await call('drB', 'updateRecord', r.recordId, sha('ciphertext-2'), 'offchain://r1v2');
            expect(u).to.include({ version: 2, author: 'clinician-b' });
            const history = await call('alice', 'getRecordHistory', r.recordId);
            expect(history.map(h => h.value.version)).to.deep.equal([1, 2]);
        });

        it('every read is written to the patient\'s access log', async () => {
            await grant('alice', 'drA', ['records:read', 'records:write']);
            const r = await call('drA', 'createRecord', 'patient-alice', 'Visit', hash, 'offchain://r1');
            await call('drA', 'accessRecord', r.recordId, 'follow-up');
            const log = await call('alice', 'getAccessLog');
            expect(log).to.have.length(1);
            expect(log[0]).to.include({ accessorId: 'clinician-a', recordId: r.recordId, via: 'consent', purpose: 'follow-up' });
        });

        it('only the patient can read their access log', async () => {
            await expect(call('drA', 'getAccessLog')).to.be.rejectedWith(/Only patient/);
        });

        it('another patient cannot read the record', async () => {
            await grant('alice', 'drA', ['records:write']);
            const r = await call('drA', 'createRecord', 'patient-alice', 'Visit', hash, 'offchain://r1');
            await expect(call('bob', 'accessRecord', r.recordId, 'curious')).to.be.rejectedWith(/no active/);
        });

        it('labs can upload results when allowed', async () => {
            await expect(call('labA', 'addLabResult', 'patient-alice', 'CBC', hash, 'offchain://lab1'))
                .to.be.rejectedWith(/lab:write/);
            await grant('alice', 'labA', ['lab:write']);
            const r = await call('labA', 'addLabResult', 'patient-alice', 'CBC', hash, 'offchain://lab1');
            expect(r).to.include({ recordType: 'lab-result', author: 'lab-a', authorMsp: LAB_ORG });
            const mine = await call('alice', 'listRecords', 'patient-alice');
            expect(mine.map(x => x.recordId)).to.deep.equal([r.recordId]);
        });
    });

    describe('emergency (break-glass) access', () => {
        let recordId;
        beforeEach(async () => {
            await grant('alice', 'drA', ['records:write']);
            recordId = (await call('drA', 'createRecord', 'patient-alice', 'Visit', sha('c'), 'offchain://r')).recordId;
        });

        it('needs a reason', async () => {
            await expect(call('drB', 'emergencyAccess', 'patient-alice', 'x')).to.be.rejectedWith(/reason/);
        });

        it('grants 24h read access, logged and visible to the patient', async () => {
            await expect(call('drB', 'accessRecord', recordId, 'ER')).to.be.rejectedWith(/no active/);
            await call('drB', 'emergencyAccess', 'patient-alice', 'Unconscious patient in ER');
            await call('drB', 'accessRecord', recordId, 'ER treatment');
            const log = await call('alice', 'getAccessLog');
            expect(log.map(l => l.action)).to.include.members(['emergency-access-granted', 'read-record']);
            expect(log.find(l => l.action === 'read-record').via).to.equal('emergency');
            const consents = await call('alice', 'listMyConsents');
            expect(consents.find(c => c.docType === 'emergency').providerId).to.equal('clinician-b');

            ledger.advance(DAY + 1000);
            await expect(call('drB', 'accessRecord', recordId, 'later')).to.be.rejectedWith(/no active/);
        });

        it('does not allow writing', async () => {
            await call('drB', 'emergencyAccess', 'patient-alice', 'Unconscious patient in ER');
            await expect(call('drB', 'updateRecord', recordId, sha('x'), 'offchain://x')).to.be.rejectedWith(/records:write/);
        });

        it('only clinicians can use it', async () => {
            await expect(call('labA', 'emergencyAccess', 'patient-alice', 'Need it urgently now')).to.be.rejectedWith(/Only clinician/);
        });

        it('the patient can end it early', async () => {
            await call('drB', 'emergencyAccess', 'patient-alice', 'Unconscious patient in ER');
            await call('alice', 'revokeAccess', 'clinician-b');
            await expect(call('drB', 'accessRecord', recordId, 'ER')).to.be.rejectedWith(/no active/);
        });
    });

    describe('personal details (private data collection)', () => {
        const details = JSON.stringify({ firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com' });

        it('are stored privately and readable only with details:read', async () => {
            await contract.setMyDetails(contextFor(ledger, users.alice, { details }));
            expect((await call('alice', 'getPatientDetails', 'patient-alice')).firstName).to.equal('Alice');
            await expect(call('drA', 'getPatientDetails', 'patient-alice')).to.be.rejectedWith(/details:read/);
            await grant('alice', 'drA', ['details:read']);
            expect((await call('drA', 'getPatientDetails', 'patient-alice')).email).to.equal('alice@example.com');
            // nothing personal in public world state
            const publicState = [...ledger.state.values()].map(b => b.toString()).join('\n');
            expect(publicState).to.not.include('alice@example.com');
        });

        it('can be erased (purged) by the patient', async () => {
            await contract.setMyDetails(contextFor(ledger, users.alice, { details }));
            await call('alice', 'eraseMyDetails');
            expect(ledger.purged).to.deep.equal(['patientDetailsCollection/patient-alice']);
            await expect(call('alice', 'getPatientDetails', 'patient-alice')).to.be.rejectedWith(/No details/);
        });
    });

    describe('wearables (paired devices, Merkle-rooted batches)', () => {
        const batch = (extra = {}) => JSON.stringify(Object.assign({
            windowStart: '2026-10-09T09:00:00Z',
            windowEnd: '2026-10-09T10:00:00Z',
            count: 1200,
            merkleRoot: sha('root'),
            stats: { heartRateMin: 55, heartRateMax: 150, heartRateAvg: 82.5, steps: 4000, calories: 210 },
        }, extra));

        it('a paired band submits a batch for its own patient (patient comes from the pairing)', async () => {
            const ctx = contextFor(ledger, users.aliceBand);
            const b = await contract.submitWearableBatch(ctx, batch());
            expect(b).to.include({ patientId: 'patient-alice', deviceId: 'band-alice', batchId: ctx.stub.getTxID() });
        });

        it('an unpaired band is rejected', async () => {
            const stranger = { mspId: HOSPITAL, role: 'wearable', id: 'band-unknown' };
            await expect(contract.submitWearableBatch(contextFor(ledger, stranger), batch())).to.be.rejectedWith(/not paired/);
        });

        it('a band from another organisation with the same id is rejected', async () => {
            const forged = { mspId: LAB_ORG, role: 'wearable', id: 'band-alice' };
            await expect(contract.submitWearableBatch(contextFor(ledger, forged), batch())).to.be.rejectedWith(/belongs to/);
        });

        it('another patient cannot hijack a paired band', async () => {
            await expect(call('bob', 'registerWearable', 'band-alice', 'mine now')).to.be.rejectedWith(/already paired/);
        });

        it('after unpairing the band can no longer submit', async () => {
            await call('alice', 'unpairWearable', 'band-alice');
            await expect(call('aliceBand', 'submitWearableBatch', batch())).to.be.rejectedWith(/not paired/);
        });

        it('can point to the encrypted raw readings off-chain', async () => {
            const b = await call('aliceBand', 'submitWearableBatch', batch({ storageUri: 'offchain://wearable/x', contentHash: sha('blob') }));
            expect(b).to.include({ storageUri: 'offchain://wearable/x', contentHash: sha('blob') });
            await expect(call('aliceBand', 'submitWearableBatch', batch({ storageUri: 'offchain://wearable/x', contentHash: 'nope' })))
                .to.be.rejectedWith(/SHA-256/);
        });

        it('validates the batch', async () => {
            await expect(call('aliceBand', 'submitWearableBatch', batch({ merkleRoot: 'abc' }))).to.be.rejectedWith(/merkleRoot/);
            await expect(call('aliceBand', 'submitWearableBatch', batch({ count: 0 }))).to.be.rejectedWith(/count/);
        });

        it('only an authorised trainer can read the batches', async () => {
            await call('aliceBand', 'submitWearableBatch', batch());
            await expect(call('trainer', 'listWearableBatches', 'patient-alice')).to.be.rejectedWith(/wearable:read/);
            await grant('alice', 'trainer', ['wearable:read']);
            expect(await call('trainer', 'listWearableBatches', 'patient-alice')).to.have.length(1);
        });
    });
});
