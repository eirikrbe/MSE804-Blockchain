/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';
/**
 * Tests for the healthcare business network, run against Composer's
 * embedded (in-memory) runtime. Each participant gets its own identity so
 * both the transaction logic and permissions.acl are exercised.
 */

const AdminConnection = require('composer-admin').AdminConnection;
const BusinessNetworkConnection = require('composer-client').BusinessNetworkConnection;
const { BusinessNetworkDefinition, CertificateUtil, IdCard } = require('composer-common');
const crypto = require('crypto');
const path = require('path');

const chai = require('chai');
chai.should();
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const NS = 'org.healthcare.com';

/**
 * Deterministic 32-char hex identifier (matches the model's regex).
 * @param {string} name human readable name
 * @return {string} identifier
 */
function hexId(name) {
    return crypto.createHash('md5').update(name).digest('hex');
}

const IDS = {
    alice: hexId('patient-alice'),
    bob: hexId('patient-bob'),
    drA: hexId('clinician-a'),
    drB: hexId('clinician-b'),
    labA: hexId('lab-a'),
    labB: hexId('lab-b'),
    trainer: hexId('trainer'),
    trainer2: hexId('trainer-2'),
    aliceBand: hexId('band-alice'),
    bobBand: hexId('band-bob')
};

describe('#' + NS, () => {
    const cardStore = require('composer-common').NetworkCardStoreManager.getCardStore({ type: 'composer-wallet-inmemory' });
    const connectionProfile = { name: 'embedded', 'x-type': 'embedded' };
    const adminCardName = 'admin';

    let adminConnection;
    let admin;           // BusinessNetworkConnection as network admin
    let factory;
    let businessNetworkName;
    const connections = {};

    /**
     * Connect as a named identity (cached).
     * @param {string} name identity name
     * @return {Promise<BusinessNetworkConnection>} connection
     */
    async function as(name) {
        if (!connections[name]) {
            const c = new BusinessNetworkConnection({ cardStore });
            await c.connect(name);
            connections[name] = c;
        }
        return connections[name];
    }

    /**
     * Create a participant of the given type, issue an identity and import a card.
     * @param {string} type participant type
     * @param {string} name identity / card name
     * @param {string} idField identifying field
     * @param {Object} extra extra fields to set
     */
    async function addParticipant(type, name, idField, extra) {
        const p = factory.newResource(NS, type, IDS[name]);
        Object.assign(p, extra || {});
        const registry = await admin.getParticipantRegistry(NS + '.' + type);
        await registry.add(p);
        const identity = await admin.issueIdentity(NS + '.' + type + '#' + IDS[name], name);
        const card = new IdCard({ userName: identity.userID, version: 1, enrollmentSecret: identity.userSecret, businessNetwork: businessNetworkName }, connectionProfile);
        await adminConnection.importCard(name, card);
    }

    /**
     * Submit a transaction as the given identity.
     * @param {string} name identity
     * @param {string} type transaction type
     * @param {Object} fields relationship / value fields
     * @return {Promise} result
     */
    async function submit(name, type, fields) {
        const conn = await as(name);
        const f = conn.getBusinessNetwork().getFactory();
        const tx = f.newTransaction(NS, type);
        Object.keys(fields).forEach(k => {
            const v = fields[k];
            tx[k] = (v && v.rel) ? f.newRelationship(NS, v.rel, v.id) : v;
        });
        await conn.submitTransaction(tx);
        return tx;
    }

    const rel = (type, name) => ({ rel: type, id: IDS[name] });

    /**
     * Read a participant as the admin and return the identifiers in a list field.
     * @param {string} type participant type
     * @param {string} name participant
     * @param {string} field list field
     * @return {Promise<string[]>} identifiers
     */
    async function idsOf(type, name, field) {
        const r = await admin.getParticipantRegistry(NS + '.' + type);
        const p = await r.get(IDS[name]);
        return (p[field] || []).map(x => x.getIdentifier()).sort();
    }

    before(async () => {
        const credentials = CertificateUtil.generate({ commonName: 'admin' });
        const deployerCard = new IdCard({ version: 1, userName: 'PeerAdmin', roles: ['PeerAdmin', 'ChannelAdmin'] }, connectionProfile);
        deployerCard.setCredentials(credentials);
        adminConnection = new AdminConnection({ cardStore });
        await adminConnection.importCard('PeerAdmin', deployerCard);
        await adminConnection.connect('PeerAdmin');
    });

    beforeEach(async () => {
        Object.keys(connections).forEach(k => delete connections[k]);
        const definition = await BusinessNetworkDefinition.fromDirectory(path.resolve(__dirname, '..'));
        businessNetworkName = definition.getName();
        await adminConnection.install(definition);
        const startResponse = await adminConnection.start(businessNetworkName, definition.getVersion(), {
            networkAdmins: [{ userName: 'admin', enrollmentSecret: 'adminpw' }]
        });
        const adminCard = new IdCard({ userName: 'admin', version: 1, businessNetwork: businessNetworkName }, connectionProfile);
        adminCard.setCredentials(startResponse.get('admin').getCredentials());
        // Cards are recreated for every test because each test starts a fresh network.
        for (const name of await adminConnection.getAllCards().then(m => Array.from(m.keys()))) {
            if (name !== 'PeerAdmin') {
                await adminConnection.deleteCard(name);
            }
        }
        await adminConnection.importCard(adminCardName, adminCard);

        admin = new BusinessNetworkConnection({ cardStore });
        await admin.connect(adminCardName);
        factory = admin.getBusinessNetwork().getFactory();

        await addParticipant('Patient', 'alice', 'patientId');
        await addParticipant('Patient', 'bob', 'patientId');
        await addParticipant('Clinician', 'drA', 'clinicianId');
        await addParticipant('Clinician', 'drB', 'clinicianId');
        await addParticipant('Lab', 'labA', 'labId');
        await addParticipant('Lab', 'labB', 'labId');
        await addParticipant('PersonalTrainer', 'trainer', 'trainerId');
        await addParticipant('PersonalTrainer', 'trainer2', 'trainerId');
        await addParticipant('Wearable', 'aliceBand', 'wearableId', {
            name: 'Alice band', owner: factory.newRelationship(NS, 'Patient', IDS.alice)
        });
        await addParticipant('Wearable', 'bobBand', 'wearableId', {
            name: 'Bob band', owner: factory.newRelationship(NS, 'Patient', IDS.bob)
        });
    });

    describe('consent: grant and revoke keep everyone else on the list', () => {
        it('granting a second clinician keeps the first one', async () => {
            await submit('alice', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') });
            await submit('alice', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drB') });
            (await idsOf('Patient', 'alice', 'authorizedClinicians')).should.deep.equal([IDS.drA, IDS.drB].sort());
            (await idsOf('Clinician', 'drA', 'patients')).should.deep.equal([IDS.alice]);
            (await idsOf('Clinician', 'drB', 'patients')).should.deep.equal([IDS.alice]);
        });

        it('a second patient granting a clinician keeps the first patient', async () => {
            await submit('alice', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') });
            await submit('bob', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') });
            (await idsOf('Clinician', 'drA', 'patients')).should.deep.equal([IDS.alice, IDS.bob].sort());
        });

        it('granting the same clinician twice does not duplicate', async () => {
            await submit('alice', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') });
            await submit('alice', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') });
            (await idsOf('Patient', 'alice', 'authorizedClinicians')).should.deep.equal([IDS.drA]);
            (await idsOf('Clinician', 'drA', 'patients')).should.deep.equal([IDS.alice]);
        });

        it('revoking one clinician keeps the others', async () => {
            await submit('alice', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') });
            await submit('alice', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drB') });
            await submit('bob', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') });
            await submit('alice', 'RevokeAccessFromClinician', { unauthorizedClinician: rel('Clinician', 'drA') });
            (await idsOf('Patient', 'alice', 'authorizedClinicians')).should.deep.equal([IDS.drB]);
            (await idsOf('Clinician', 'drA', 'patients')).should.deep.equal([IDS.bob]);
        });

        it('revoking one lab keeps the other lab', async () => {
            await submit('alice', 'GrantAccessToLab', { authorizedLab: rel('Lab', 'labA') });
            await submit('alice', 'GrantAccessToLab', { authorizedLab: rel('Lab', 'labB') });
            await submit('alice', 'RevokeAccessFromLab', { unauthorizedLab: rel('Lab', 'labA') });
            (await idsOf('Patient', 'alice', 'authorizedLabs')).should.deep.equal([IDS.labB]);
            (await idsOf('Lab', 'labA', 'patients')).should.deep.equal([]);
            (await idsOf('Lab', 'labB', 'patients')).should.deep.equal([IDS.alice]);
        });

        it('trainer access is recorded on the patient side too', async () => {
            await submit('alice', 'GrantAccessToTrainer', { authorizedTrainer: rel('PersonalTrainer', 'trainer') });
            await submit('alice', 'GrantAccessToTrainer', { authorizedTrainer: rel('PersonalTrainer', 'trainer2') });
            (await idsOf('Patient', 'alice', 'authorizedTrainers')).should.deep.equal([IDS.trainer, IDS.trainer2].sort());
            await submit('alice', 'RevokeAccessFromTrainer', { unauthorizedTrainer: rel('PersonalTrainer', 'trainer') });
            (await idsOf('Patient', 'alice', 'authorizedTrainers')).should.deep.equal([IDS.trainer2]);
            (await idsOf('PersonalTrainer', 'trainer', 'patients')).should.deep.equal([]);
        });
    });

    describe('security: providers cannot give themselves access', () => {
        it('a clinician cannot add a patient to their own list', async () => {
            const conn = await as('drA');
            const registry = await conn.getParticipantRegistry(NS + '.Clinician');
            const me = await registry.get(IDS.drA);
            me.patients = [conn.getBusinessNetwork().getFactory().newRelationship(NS, 'Patient', IDS.alice)];
            await registry.update(me).should.be.rejectedWith(/does not have .* access/);
        });

        it('a lab cannot add a patient to its own list', async () => {
            const conn = await as('labA');
            const registry = await conn.getParticipantRegistry(NS + '.Lab');
            const me = await registry.get(IDS.labA);
            me.patients = [conn.getBusinessNetwork().getFactory().newRelationship(NS, 'Patient', IDS.alice)];
            await registry.update(me).should.be.rejectedWith(/does not have .* access/);
        });

        it('a patient cannot edit an arbitrary clinician directly', async () => {
            const conn = await as('alice');
            const registry = await conn.getParticipantRegistry(NS + '.Clinician');
            const dr = await registry.get(IDS.drA);
            dr.patients = [conn.getBusinessNetwork().getFactory().newRelationship(NS, 'Patient', IDS.bob)];
            await registry.update(dr).should.be.rejectedWith(/does not have .* access/);
        });

        it('a patient cannot edit their own access list outside a consent transaction', async () => {
            const conn = await as('alice');
            const registry = await conn.getParticipantRegistry(NS + '.Patient');
            const me = await registry.get(IDS.alice);
            me.authorizedClinicians = [conn.getBusinessNetwork().getFactory().newRelationship(NS, 'Clinician', IDS.drA)];
            await registry.update(me).should.be.rejectedWith(/does not have .* access/);
        });

        it('a clinician cannot submit a consent transaction', async () => {
            await submit('drA', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') })
                .should.be.rejectedWith(/does not have .* access/);
        });

        it('a patient cannot read another patient', async () => {
            const conn = await as('alice');
            const registry = await conn.getParticipantRegistry(NS + '.Patient');
            await registry.get(IDS.bob).should.be.rejected;
        });
    });

    describe('medical records', () => {
        const record = {
            medicalHistory: 'asthma', allergies: 'penicillin', currentMedication: 'salbutamol',
            lastConsultationDate: '2026-10-01', activeHoursInAWeek: '5', smoking: false
        };

        it('an unauthorised clinician cannot create a record', async () => {
            await submit('drA', 'InitialMedicalRecord', Object.assign({
                owner: rel('Patient', 'alice'), lastConsultationWith: rel('Clinician', 'drA')
            }, record)).should.be.rejected;
        });

        it('an authorised clinician creates a record keyed by the transaction ID', async () => {
            await submit('alice', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') });
            const tx = await submit('drA', 'InitialMedicalRecord', Object.assign({
                owner: rel('Patient', 'alice'), lastConsultationWith: rel('Clinician', 'drA')
            }, record));
            const records = await admin.getAssetRegistry(NS + '.MedicalRecord');
            const r = await records.get(tx.getIdentifier());
            r.allergies.should.equal('penicillin');
            r.version.should.equal(0);
            r.author.getIdentifier().should.equal(IDS.drA);

            // the patient can read it, another patient cannot
            const aliceRecords = await (await as('alice')).getAssetRegistry(NS + '.MedicalRecord');
            (await aliceRecords.get(tx.getIdentifier())).recordId.should.equal(tx.getIdentifier());
            const bobRecords = await (await as('bob')).getAssetRegistry(NS + '.MedicalRecord');
            await bobRecords.get(tx.getIdentifier()).should.be.rejected;
        });

        it('a second clinician can update; lastConsultationWith is the updater; revoked clinician cannot', async () => {
            await submit('alice', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') });
            await submit('alice', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drB') });
            const tx = await submit('drA', 'InitialMedicalRecord', Object.assign({
                owner: rel('Patient', 'alice'), lastConsultationWith: rel('Clinician', 'drA')
            }, record));
            const recordId = tx.getIdentifier();

            await submit('drB', 'UpdateMedicalRecord', Object.assign({}, record, {
                medicalRecord: { rel: 'MedicalRecord', id: recordId }, allergies: 'none'
            }));
            const r = await (await admin.getAssetRegistry(NS + '.MedicalRecord')).get(recordId);
            r.version.should.equal(1);
            r.allergies.should.equal('none');
            r.lastConsultationWith.getIdentifier().should.equal(IDS.drB);

            await submit('alice', 'RevokeAccessFromClinician', { unauthorizedClinician: rel('Clinician', 'drA') });
            await submit('drA', 'UpdateMedicalRecord', Object.assign({}, record, {
                medicalRecord: { rel: 'MedicalRecord', id: recordId }
            })).should.be.rejected;
        });

        it('a clinician cannot delete a record', async () => {
            await submit('alice', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') });
            const tx = await submit('drA', 'InitialMedicalRecord', Object.assign({
                owner: rel('Patient', 'alice'), lastConsultationWith: rel('Clinician', 'drA')
            }, record));
            const records = await (await as('drA')).getAssetRegistry(NS + '.MedicalRecord');
            await records.remove(tx.getIdentifier()).should.be.rejectedWith(/does not have .* access/);
        });

        it('an authorised lab can read the record, an unauthorised lab cannot', async () => {
            await submit('alice', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') });
            await submit('alice', 'GrantAccessToLab', { authorizedLab: rel('Lab', 'labA') });
            const tx = await submit('drA', 'InitialMedicalRecord', Object.assign({
                owner: rel('Patient', 'alice'), lastConsultationWith: rel('Clinician', 'drA')
            }, record));
            const labA = await (await as('labA')).getAssetRegistry(NS + '.MedicalRecord');
            (await labA.get(tx.getIdentifier())).allergies.should.equal('penicillin');
            const labB = await (await as('labB')).getAssetRegistry(NS + '.MedicalRecord');
            await labB.get(tx.getIdentifier()).should.be.rejected;
        });
    });

    describe('wearables', () => {
        const reading = { pedometer: 100, calories: 4, heartbeat: 72 };

        it('a band submits readings for its own patient', async () => {
            const tx = await submit('aliceBand', 'SendWearableData', Object.assign({
                owner: rel('Patient', 'alice'), device: rel('Wearable', 'aliceBand')
            }, reading));
            const data = await (await admin.getAssetRegistry(NS + '.WearableData')).get(tx.getIdentifier());
            data.heartbeat.should.equal(72);
            data.owner.getIdentifier().should.equal(IDS.alice);
        });

        it('a band cannot submit readings for another patient', async () => {
            await submit('aliceBand', 'SendWearableData', Object.assign({
                owner: rel('Patient', 'bob'), device: rel('Wearable', 'aliceBand')
            }, reading)).should.be.rejected;
        });

        it('a band cannot impersonate another band', async () => {
            await submit('aliceBand', 'SendWearableData', Object.assign({
                owner: rel('Patient', 'bob'), device: rel('Wearable', 'bobBand')
            }, reading)).should.be.rejected;
        });

        it('a band cannot modify or delete stored readings', async () => {
            await submit('aliceBand', 'SendWearableData', Object.assign({
                owner: rel('Patient', 'alice'), device: rel('Wearable', 'aliceBand')
            }, reading));
            const stored = await (await admin.getAssetRegistry(NS + '.WearableData')).getAll();
            stored.should.have.length(1);
            const registry = await (await as('aliceBand')).getAssetRegistry(NS + '.WearableData');
            await registry.remove(stored[0].getIdentifier()).should.be.rejectedWith(/does not have .* access/);
        });

        it('only an authorised trainer can read the readings', async () => {
            await submit('alice', 'GrantAccessToTrainer', { authorizedTrainer: rel('PersonalTrainer', 'trainer') });
            const tx = await submit('aliceBand', 'SendWearableData', Object.assign({
                owner: rel('Patient', 'alice'), device: rel('Wearable', 'aliceBand')
            }, reading));
            const t1 = await (await as('trainer')).getAssetRegistry(NS + '.WearableData');
            (await t1.get(tx.getIdentifier())).pedometer.should.equal(100);
            const t2 = await (await as('trainer2')).getAssetRegistry(NS + '.WearableData');
            await t2.get(tx.getIdentifier()).should.be.rejected;
        });
    });

    describe('history', () => {
        it('a patient cannot read another participant\'s historian records', async () => {
            await submit('bob', 'GrantAccessToClinician', { authorizedClinician: rel('Clinician', 'drA') });
            const conn = await as('alice');
            const historian = await conn.getHistorian();
            const all = await historian.getAll();
            expect(all.filter(h => h.participantInvoking && h.participantInvoking.getIdentifier() === IDS.bob)).to.have.length(0);
        });
    });
});
