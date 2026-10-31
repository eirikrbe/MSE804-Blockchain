'use strict';

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const TraceContract = require('../src/traceContract');
const { merkleRoot, merkleProof, verifyProof, summarise } = require('../src/merkle');
const { Ledger, invoke } = require('./mockContext');

const RETAIL = 'Org1MSP';
const SUPPLY = 'Org2MSP';

const users = {
    farmA: { mspId: SUPPLY, role: 'farm', id: 'farm-a' },
    farmB: { mspId: SUPPLY, role: 'farm', id: 'farm-b' },
    proc: { mspId: SUPPLY, role: 'processor', id: 'proc-1' },
    proc2: { mspId: SUPPLY, role: 'processor', id: 'proc-2' },
    certifier: { mspId: SUPPLY, role: 'certifier', id: 'halal-cert' },
    certifier2: { mspId: SUPPLY, role: 'certifier', id: 'halal-cert-2' },
    logistics: { mspId: RETAIL, role: 'logistics', id: 'dc-auckland' },
    store: { mspId: RETAIL, role: 'retailer', id: 'store-101' },
    mpi: { mspId: RETAIL, role: 'regulator', id: 'regulator' },
    truckSensor: { mspId: RETAIL, role: 'sensor', id: 'sensor-truck-1' },
    storeSensor: { mspId: RETAIL, role: 'sensor', id: 'sensor-chiller-1' },
};

const NZBN = '9429000000000';
const DAY = 24 * 60 * 60 * 1000;
const json = JSON.stringify;

describe('TraceContract', () => {
    let ledger;
    let contract;

    const call = (user, fn, ...args) => invoke(contract, ledger, users[user], fn, ...args);
    const inDays = d => new Date(ledger.time + d * DAY).toISOString();
    const product = (lotId, name, weightKg, extra) => Object.assign(
        { lotId, gtin: '9412345000017', product: name, weightKg, useBy: inDays(10) }, extra);

    /** Farm A's two cattle become two halal carcasses; carcass C-1 is cut into steak and trim. */
    async function beefToCuts() {
        await call('farmA', 'registerAnimalLot', 'A-BEEF-1', 'beef', json({ naitIds: ['NAIT-001', 'NAIT-002'] }), 1100);
        await call('farmA', 'transferLot', 'A-BEEF-1', 'proc-1', 'Plant 1');
        await call('certifier', 'issueCredential', 'proc-1', 'halal', json({ scheme: 'example' }), inDays(365));
        await call('proc', 'slaughterLot', 'A-BEEF-1', json([{ lotId: 'C-1', weightKg: 300 }, { lotId: 'C-2', weightKg: 300 }]), 'true');
        await call('proc', 'splitLot', 'C-1', json([product('P-STEAK-1', 'Scotch fillet', 20), product('P-TRIM-1', 'Beef trim', 60)]));
    }

    /** Farm B's animals are slaughtered by a plant with no halal credential. */
    async function nonHalalCarcass() {
        await call('farmB', 'registerAnimalLot', 'B-BEEF-1', 'beef', json({ naitIds: ['NAIT-100'] }), 500);
        await call('farmB', 'transferLot', 'B-BEEF-1', 'proc-1', 'Plant 1');
        // proc-1 slaughters this lot without claiming halal.
        await call('proc', 'slaughterLot', 'B-BEEF-1', json([{ lotId: 'C-9', weightKg: 260 }]), 'false');
    }

    async function shipToStore(lotId) {
        await call('proc', 'transferLot', lotId, 'dc-auckland', 'Plant 1 dispatch');
        await call('logistics', 'transferLot', lotId, 'store-101', 'Store 101 back door');
    }

    beforeEach(async () => {
        ledger = new Ledger();
        contract = new TraceContract();
        for (const u of ['farmA', 'farmB', 'proc', 'proc2', 'certifier', 'certifier2', 'logistics', 'store', 'mpi']) {
            await call(u, 'registerParticipant', `${u} Ltd`, NZBN);
        }
        await call('logistics', 'registerSensor', users.truckSensor.id);
        await call('store', 'registerSensor', users.storeSensor.id);
    });

    describe('identity', () => {
        it('takes role and id from the certificate and validates the NZBN', async () => {
            const lot = await call('farmA', 'registerAnimalLot', 'A-1', 'lamb', json({ asdRef: 'ASD-77', headCount: 40 }), 1800);
            expect(lot).to.include({ custodianId: 'farm-a', species: 'lamb' });
            const fresh = new Ledger();
            await expect(invoke(contract, fresh, users.farmA, 'registerParticipant', 'x', '123'))
                .to.be.rejectedWith(/13-digit/);
        });

        it('rejects a certificate whose MSP differs from the registered one', async () => {
            const forged = { mspId: RETAIL, role: 'farm', id: 'farm-a' };
            await expect(invoke(contract, ledger, forged, 'registerAnimalLot', 'A-2', 'lamb', json({ asdRef: 'a', headCount: 1 }), 50))
                .to.be.rejectedWith(/does not match/);
        });

        it('sensors cannot self-register as participants', async () => {
            await expect(call('truckSensor', 'registerParticipant', 'x', NZBN)).to.be.rejectedWith(/cannot self-register/);
        });
    });

    describe('animal lots', () => {
        it('beef needs NAIT numbers', async () => {
            await expect(call('farmA', 'registerAnimalLot', 'A-3', 'beef', json({ asdRef: 'x', headCount: 2 }), 900))
                .to.be.rejectedWith(/NAIT/);
            const lot = await call('farmA', 'registerAnimalLot', 'A-3', 'beef', json({ naitIds: ['N2', 'N1', 'N1'] }), 900);
            expect(lot.identifiers).to.deep.equal({ naitIds: ['N1', 'N2'], headCount: 2 });
        });

        it('lamb needs an ASD reference and head count (sheep are not in NAIT)', async () => {
            await expect(call('farmA', 'registerAnimalLot', 'A-4', 'lamb', json({ naitIds: ['N1'] }), 900))
                .to.be.rejectedWith(/ASD/);
        });

        it('only beef and lamb are in scope', async () => {
            await expect(call('farmA', 'registerAnimalLot', 'A-5', 'pork', json({}), 100)).to.be.rejectedWith(/species/);
        });
    });

    describe('custody', () => {
        it('only the current custodian can transfer, and only to a business that holds goods', async () => {
            await call('farmA', 'registerAnimalLot', 'A-6', 'lamb', json({ asdRef: 'ASD-1', headCount: 10 }), 450);
            await expect(call('farmB', 'transferLot', 'A-6', 'proc-1', 'x')).to.be.rejectedWith(/held by farm-a/);
            await expect(call('farmA', 'transferLot', 'A-6', 'halal-cert', 'x')).to.be.rejectedWith(/cannot take custody/);
            const lot = await call('farmA', 'transferLot', 'A-6', 'proc-1', 'Plant 1');
            expect(lot.custodianId).to.equal('proc-1');
        });
    });

    describe('credentials', () => {
        it('only certifiers issue credentials, and only to processors', async () => {
            await expect(call('proc', 'issueCredential', 'proc-1', 'halal', '{}', inDays(30))).to.be.rejectedWith(/Only certifier/);
            await expect(call('certifier', 'issueCredential', 'farm-a', 'halal', '{}', inDays(30))).to.be.rejectedWith(/processors/);
        });

        it('only the issuing certifier can revoke', async () => {
            const cred = await call('certifier', 'issueCredential', 'proc-1', 'halal', '{}', inDays(30));
            await expect(call('certifier2', 'revokeCredential', cred.credId, 'x')).to.be.rejectedWith(/issuing certifier/);
            const revoked = await call('certifier', 'revokeCredential', cred.credId, 'audit failure');
            expect(revoked.status).to.equal('revoked');
        });
    });

    describe('slaughter, cutting and halal', () => {
        it('halal slaughter needs an active halal credential', async () => {
            await call('farmA', 'registerAnimalLot', 'A-7', 'beef', json({ naitIds: ['N7'] }), 500);
            await call('farmA', 'transferLot', 'A-7', 'proc-2', 'Plant 2');
            await expect(call('proc2', 'slaughterLot', 'A-7', json([{ lotId: 'C-7', weightKg: 250 }]), 'true'))
                .to.be.rejectedWith(/no active halal credential/);
        });

        it('an expired credential cannot be used for a new halal slaughter', async () => {
            await call('certifier', 'issueCredential', 'proc-2', 'halal', '{}', inDays(5));
            ledger.advance(6 * DAY);
            await call('farmA', 'registerAnimalLot', 'A-8', 'beef', json({ naitIds: ['N8'] }), 500);
            await call('farmA', 'transferLot', 'A-8', 'proc-2', 'Plant 2');
            await expect(call('proc2', 'slaughterLot', 'A-8', json([{ lotId: 'C-8', weightKg: 250 }]), 'true'))
                .to.be.rejectedWith(/no active halal credential/);
        });

        it('the halal claim travels from slaughter to each retail cut', async () => {
            await beefToCuts();
            const steak = await call('store', 'getLot', 'P-STEAK-1');
            expect(steak.halal).to.have.length(1);
            expect(steak.parentIds).to.deep.equal(['C-1']);
            expect(steak.originFarmIds).to.deep.equal(['farm-a']);
        });

        it('carcasses cannot outweigh the animals, and cuts cannot outweigh the carcass', async () => {
            await call('farmA', 'registerAnimalLot', 'A-9', 'beef', json({ naitIds: ['N9'] }), 500);
            await call('farmA', 'transferLot', 'A-9', 'proc-1', 'Plant 1');
            await expect(call('proc', 'slaughterLot', 'A-9', json([{ lotId: 'C-90', weightKg: 600 }]), 'false'))
                .to.be.rejectedWith(/cannot weigh more/);
            await call('proc', 'slaughterLot', 'A-9', json([{ lotId: 'C-90', weightKg: 260 }]), 'false');
            await expect(call('proc', 'splitLot', 'C-90', json([product('P-90', 'Mince', 300)])))
                .to.be.rejectedWith(/cannot weigh more/);
        });

        it('a lot can only be processed once', async () => {
            await beefToCuts();
            await expect(call('proc', 'splitLot', 'C-1', json([product('P-X', 'Extra', 1)])))
                .to.be.rejectedWith(/already been processed/);
        });

        it('a failed transaction writes nothing', async () => {
            await call('farmA', 'registerAnimalLot', 'A-10', 'beef', json({ naitIds: ['N10'] }), 500);
            await call('farmA', 'transferLot', 'A-10', 'proc-1', 'Plant 1');
            await expect(call('proc', 'slaughterLot', 'A-10',
                json([{ lotId: 'C-100', weightKg: 200 }, { lotId: 'C-101', weightKg: -1 }]), 'false'))
                .to.be.rejectedWith(/positive/);
            await expect(call('store', 'getLot', 'C-100')).to.be.rejectedWith(/does not exist/);
            const parent = await call('store', 'getLot', 'A-10');
            expect(parent.consumed).to.equal(false);
        });
    });

    describe('mixing', () => {
        it('mince from a halal and a non-halal carcass loses the halal claim', async () => {
            await beefToCuts();
            await nonHalalCarcass();
            const mince = await call('proc', 'mergeLots', json(['P-TRIM-1', 'C-9']), json(product('P-MINCE-1', 'Beef mince', 250)));
            expect(mince.halal).to.deep.equal([]);
            expect(mince.originFarmIds).to.deep.equal(['farm-a', 'farm-b']);
            const events = await call('store', 'getLotEvents', 'P-MINCE-1');
            expect(events[0].details.halalDroppedByMixing).to.equal(true);
        });

        it('beef and lamb cannot be merged', async () => {
            await beefToCuts();
            await call('farmB', 'registerAnimalLot', 'B-LAMB-1', 'lamb', json({ asdRef: 'ASD-9', headCount: 5 }), 200);
            await call('farmB', 'transferLot', 'B-LAMB-1', 'proc-1', 'Plant 1');
            await call('proc', 'slaughterLot', 'B-LAMB-1', json([{ lotId: 'L-1', weightKg: 90 }]), 'true');
            await expect(call('proc', 'mergeLots', json(['P-TRIM-1', 'L-1']), json(product('P-MIX', 'Mix', 100))))
                .to.be.rejectedWith(/different species/);
        });
    });

    describe('cold chain', () => {
        const readings = (temps, startIso) => temps.map((tempC, i) => ({
            ts: new Date(Date.parse(startIso) + i * 10 * 60000).toISOString(), tempC,
        }));

        it('a sensor can only report on lots its owner holds', async () => {
            await beefToCuts();
            const batch = summarise(readings([2, 2, 3], '2026-11-02T09:00:00Z'), 4);
            await expect(call('truckSensor', 'submitColdChainBatch', 'P-STEAK-1', json(batch)))
                .to.be.rejectedWith(/does not hold/);
            const unknown = { mspId: RETAIL, role: 'sensor', id: 'sensor-rogue' };
            await expect(invoke(contract, ledger, unknown, 'submitColdChainBatch', 'P-STEAK-1', json(batch)))
                .to.be.rejectedWith(/not registered/);
        });

        it('a long excursion quarantines the lot until the regulator releases it', async () => {
            await beefToCuts();
            await call('proc', 'transferLot', 'P-STEAK-1', 'dc-auckland', 'dispatch');
            const warm = summarise(readings([3, 7, 8, 8, 7, 6, 3], '2026-11-02T09:00:00Z'), 4);
            expect(warm.minutesAbove).to.equal(50);
            const entry = await call('truckSensor', 'submitColdChainBatch', 'P-STEAK-1', json(warm));
            expect(entry.excursion).to.equal(true);
            let check = await call('store', 'checkSaleable', 'P-STEAK-1');
            expect(check.saleable).to.equal(false);
            await expect(call('logistics', 'releaseQuarantine', 'P-STEAK-1', 'checked and fine')).to.be.rejectedWith(/Only regulator/);
            await call('mpi', 'releaseQuarantine', 'P-STEAK-1', 'Core temperature tested within limits');
            check = await call('store', 'checkSaleable', 'P-STEAK-1');
            expect(check.saleable).to.equal(true);
        });

        it('a short spike within the allowed minutes does not quarantine', async () => {
            await beefToCuts();
            await call('proc', 'transferLot', 'P-STEAK-1', 'dc-auckland', 'dispatch');
            const spike = summarise(readings([3, 6, 3, 3], '2026-11-02T09:00:00Z'), 4);
            const entry = await call('truckSensor', 'submitColdChainBatch', 'P-STEAK-1', json(spike));
            expect(entry.excursion).to.equal(false);
        });

        it('the Merkle root proves any single reading belonged to the batch', () => {
            const r = readings([2, 3, 4, 3, 2], '2026-11-02T09:00:00Z');
            const root = merkleRoot(r);
            const proof = merkleProof(r, 3);
            expect(verifyProof(r[3], proof, root)).to.equal(true);
            expect(verifyProof(Object.assign({}, r[3], { tempC: 1 }), proof, root)).to.equal(false);
        });
    });

    describe('recall', () => {
        it('recalling one carcass reaches every product made from it, wherever it is', async () => {
            await beefToCuts();
            await nonHalalCarcass();
            await call('proc', 'mergeLots', json(['P-TRIM-1', 'C-9']), json(product('P-MINCE-1', 'Beef mince', 250)));
            await shipToStore('P-MINCE-1');
            const result = await call('proc', 'recall', 'C-1', 'E. coli detected in carcass sample');
            expect(result.lots.map(l => l.lotId).sort()).to.deep.equal(['C-1', 'P-MINCE-1', 'P-STEAK-1', 'P-TRIM-1']);
            expect(result.lots.find(l => l.lotId === 'P-MINCE-1').custodianId).to.equal('store-101');
            const check = await call('store', 'checkSaleable', 'P-MINCE-1');
            expect(check.saleable).to.equal(false);
            // The other carcass from the same animals is not caught by a carcass-level recall.
            expect((await call('store', 'getLot', 'C-2')).status).to.equal('ok');
        });

        it('a processor cannot recall product it never handled; the regulator can', async () => {
            await beefToCuts();
            await expect(call('proc2', 'recall', 'C-1', 'suspected contamination')).to.be.rejectedWith(/only the regulator/);
            const result = await call('mpi', 'recall', 'A-BEEF-1', 'Residue found in herd testing');
            expect(result.recalled).to.equal(5);
        });

        it('a recalled lot cannot be moved on', async () => {
            await beefToCuts();
            await call('proc', 'recall', 'P-STEAK-1', 'Labelling error found');
            await expect(call('proc', 'transferLot', 'P-STEAK-1', 'dc-auckland', 'x')).to.be.rejectedWith(/recalled/);
        });
    });

    describe('point of sale', () => {
        it('a revoked halal certificate makes the claim invalid at the checkout', async () => {
            await beefToCuts();
            const [ref] = (await call('store', 'getLot', 'P-STEAK-1')).halal;
            await call('certifier', 'revokeCredential', ref.credId, 'Audit found non-compliant slaughter');
            const check = await call('store', 'checkSaleable', 'P-STEAK-1');
            expect(check).to.include({ halalClaim: true, halalValid: false, saleable: false });
        });

        it('a certificate that expires after slaughter still covers the product', async () => {
            await call('certifier', 'issueCredential', 'proc-2', 'halal', '{}', inDays(2));
            await call('farmA', 'registerAnimalLot', 'A-11', 'lamb', json({ asdRef: 'ASD-11', headCount: 3 }), 120);
            await call('farmA', 'transferLot', 'A-11', 'proc-2', 'Plant 2');
            await call('proc2', 'slaughterLot', 'A-11', json([{ lotId: 'L-11', weightKg: 55 }]), 'true');
            await call('proc2', 'splitLot', 'L-11', json([product('P-LAMB-11', 'Lamb rack', 10)]));
            ledger.advance(3 * DAY);
            const check = await call('store', 'checkSaleable', 'P-LAMB-11');
            expect(check).to.include({ halalClaim: true, halalValid: true, saleable: true });
        });

        it('a product past its use-by date is not saleable', async () => {
            await beefToCuts();
            ledger.advance(11 * DAY);
            const check = await call('store', 'checkSaleable', 'P-STEAK-1');
            expect(check.saleable).to.equal(false);
            expect(check.reasons).to.include('past its use-by date');
        });
    });

    describe('provenance', () => {
        it('shows farms, processor, certifier and cold chain, with business names only', async () => {
            await beefToCuts();
            await call('proc', 'transferLot', 'P-STEAK-1', 'dc-auckland', 'dispatch');
            await call('truckSensor', 'submitColdChainBatch', 'P-STEAK-1',
                json(summarise([{ ts: '2026-11-02T09:00:00Z', tempC: 2 }, { ts: '2026-11-02T10:00:00Z', tempC: 3 }], 4)));
            const view = await call('store', 'getProvenance', 'P-STEAK-1');
            expect(view.farms).to.deep.equal([{ farm: 'farmA Ltd', species: 'beef', headCount: 2, tracing: 'NAIT' }]);
            expect(view.processors).to.deep.equal(['proc Ltd']);
            expect(view.halal).to.deep.equal([{ certifier: 'certifier Ltd', status: 'active' }]);
            expect(view.coldChain).to.deep.equal({ batches: 1, excursions: 0, maxC: 3 });
            expect(JSON.stringify(view)).to.not.include(NZBN);
        });
    });
});
