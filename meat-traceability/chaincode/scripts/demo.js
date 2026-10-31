'use strict';

/**
 * Walk-through of the prototype without a Fabric network: the same contract
 * code, run against the in-memory ledger used by the unit tests.
 *
 *   node scripts/demo.js
 *
 * Every business below is fictional.
 */

const TraceContract = require('../src/traceContract');
const { summarise } = require('../src/merkle');
const { Ledger, invoke } = require('../test/mockContext');

const RETAIL = 'Org1MSP';
const SUPPLY = 'Org2MSP';
const users = {
    farm: { mspId: SUPPLY, role: 'farm', id: 'farm-a', name: 'Example Station A', nzbn: '9429000000001' },
    farmB: { mspId: SUPPLY, role: 'farm', id: 'farm-b', name: 'Example Farm B', nzbn: '9429000000002' },
    plant: { mspId: SUPPLY, role: 'processor', id: 'plant-1', name: 'Example Meat Processor', nzbn: '9429000000003' },
    certifier: { mspId: SUPPLY, role: 'certifier', id: 'halal-cert', name: 'Example Halal Certifier', nzbn: '9429000000004' },
    dc: { mspId: RETAIL, role: 'logistics', id: 'dc-auckland', name: 'Retailer DC Auckland', nzbn: '9429000000005' },
    store: { mspId: RETAIL, role: 'retailer', id: 'store-101', name: 'Store 101', nzbn: '9429000000006' },
    mpi: { mspId: RETAIL, role: 'regulator', id: 'regulator', name: 'Food regulator', nzbn: '9429000000007' },
    truckSensor: { mspId: RETAIL, role: 'sensor', id: 'sensor-truck-1' },
};

const DAY = 24 * 60 * 60 * 1000;
const json = JSON.stringify;

async function main() {
    const ledger = new Ledger('2026-11-02T06:00:00Z');
    const contract = new TraceContract();
    const call = (u, fn, ...args) => invoke(contract, ledger, users[u], fn, ...args);
    const inDays = d => new Date(ledger.time + d * DAY).toISOString();
    const step = (n, text) => console.log(`\n${n}. ${text}`);

    step(1, 'Businesses register; role and ID come from their certificates');
    for (const u of ['farm', 'farmB', 'plant', 'certifier', 'dc', 'store', 'mpi']) {
        await call(u, 'registerParticipant', users[u].name, users[u].nzbn);
    }
    await call('dc', 'registerSensor', users.truckSensor.id);
    console.log('   7 participants and 1 truck sensor registered');

    step(2, 'The certifier issues a halal credential to the processing plant');
    const cred = await call('certifier', 'issueCredential', 'plant-1', 'halal', json({ scheme: 'example' }), inDays(365));
    console.log(`   credential ${cred.credId.slice(0, 12)}… valid until ${cred.expiresAt.slice(0, 10)}`);

    step(3, 'Farms send cattle (NAIT numbers) to the plant');
    await call('farm', 'registerAnimalLot', 'A-BEEF-1', 'beef', json({ naitIds: ['NAIT-001', 'NAIT-002'] }), 1100);
    await call('farm', 'transferLot', 'A-BEEF-1', 'plant-1', 'Plant 1');
    await call('farmB', 'registerAnimalLot', 'B-BEEF-1', 'beef', json({ naitIds: ['NAIT-100'] }), 500);
    await call('farmB', 'transferLot', 'B-BEEF-1', 'plant-1', 'Plant 1');

    step(4, 'Halal slaughter of farm A cattle, standard slaughter of farm B cattle');
    await call('plant', 'slaughterLot', 'A-BEEF-1', json([{ lotId: 'C-1', weightKg: 300 }, { lotId: 'C-2', weightKg: 300 }]), 'true');
    await call('plant', 'slaughterLot', 'B-BEEF-1', json([{ lotId: 'C-9', weightKg: 260 }]), 'false');

    step(5, 'Cutting and mince: mixing halal trim with non-halal beef drops the claim');
    const product = (lotId, name, weightKg) => ({ lotId, gtin: '9412345000017', product: name, weightKg, useBy: inDays(10) });
    await call('plant', 'splitLot', 'C-1', json([product('P-STEAK-1', 'Scotch fillet', 20), product('P-TRIM-1', 'Beef trim', 60)]));
    const mince = await call('plant', 'mergeLots', json(['P-TRIM-1', 'C-9']), json(product('P-MINCE-1', 'Beef mince', 250)));
    console.log(`   steak halal: yes · mince halal: ${mince.halal.length ? 'yes' : 'no (mixed inputs)'}`);

    step(6, 'Shipping: the truck sensor reports a warm hour for the steak');
    for (const lot of ['P-STEAK-1', 'P-MINCE-1']) {
        await call('plant', 'transferLot', lot, 'dc-auckland', 'Plant 1 dispatch');
    }
    const temps = [3, 7, 8, 8, 7, 6, 3];
    const readings = temps.map((tempC, i) => ({ ts: new Date(ledger.time + i * 10 * 60000).toISOString(), tempC }));
    const batch = summarise(readings, 4);
    const entry = await call('truckSensor', 'submitColdChainBatch', 'P-STEAK-1', json(batch));
    console.log(`   ${batch.count} readings, max ${batch.maxC} °C, ${batch.minutesAbove} min above 4 °C → excursion: ${entry.excursion}`);
    console.log(`   Merkle root on the ledger: ${batch.merkleRoot.slice(0, 16)}…`);

    step(7, 'The DC delivers the mince to Store 101; checkout scans both products');
    await call('dc', 'transferLot', 'P-MINCE-1', 'store-101', 'Store 101');
    for (const lot of ['P-STEAK-1', 'P-MINCE-1']) {
        const c = await call('store', 'checkSaleable', lot);
        console.log(`   ${lot}: saleable=${c.saleable}${c.reasons.length ? ` (${c.reasons.join('; ')})` : ''}`);
    }

    step(8, 'A lab finds E. coli in carcass C-1: one recall call finds every affected pack');
    ledger.advance(2 * DAY);
    const r = await call('plant', 'recall', 'C-1', 'E. coli detected in carcass sample');
    for (const l of r.lots) {
        console.log(`   ${l.lotId.padEnd(10)} ${(l.product || l.kind).padEnd(14)} now held by ${l.custodianId}`);
    }
    const after = await call('store', 'checkSaleable', 'P-MINCE-1');
    console.log(`   checkout scan of P-MINCE-1 → saleable=${after.saleable} (${after.reasons.join('; ')})`);

    step(9, 'What a shopper sees from the QR code on the mince (before the recall it would show status ok)');
    console.log(JSON.stringify(await call('store', 'getProvenance', 'P-MINCE-1'), null, 2).replace(/^/gm, '   '));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
