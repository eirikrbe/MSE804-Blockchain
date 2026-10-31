/*
 * Seed a local chain with demo businesses and lots, so the dApp has data.
 *
 *   truffle develop          (in one terminal; keep it open)
 *   truffle(develop)> migrate
 *   truffle(develop)> exec scripts/seed.js
 *
 * Accounts (from `truffle develop`): 0 admin, 1 farm A, 2 farm B, 3 plant,
 * 4 certifier, 5 DC, 6 store, 7 regulator, 8 truck sensor. Every business is fictional.
 */
const MeatTrace = artifacts.require('MeatTrace');

const Role = { Farm: 2, Processor: 3, Logistics: 4, Retailer: 5, Certifier: 6, Regulator: 7 };
const DAY = 24 * 60 * 60;
const KG = 1000;

module.exports = async function (callback) {
  try {
    const accounts = await web3.eth.getAccounts();
    const [admin, farmA, farmB, plant, certifier, dc, store, regulator, truckSensor] = accounts;
    const trace = await MeatTrace.deployed();
    const now = Number((await web3.eth.getBlock('latest')).timestamp);
    const id = async ref => (await trace.idOf(ref)).toNumber();
    const product = (ref, name, kg) => ({ ref, gtin: '9412345000017', product: name, weightGrams: kg * KG, useBy: now + 10 * DAY, maxTempTenths: 40 });

    const people = [
      [farmA, Role.Farm, 'Example Station A'],
      [farmB, Role.Farm, 'Example Farm B'],
      [plant, Role.Processor, 'Example Meat Processor'],
      [certifier, Role.Certifier, 'Example Halal Certifier'],
      [dc, Role.Logistics, 'Retailer DC Auckland'],
      [store, Role.Retailer, 'Store 101'],
      [regulator, Role.Regulator, 'Food regulator'],
    ];
    for (const [a, r, n] of people) {
      await trace.registerParticipant(a, r, n, '9429000000000', { from: admin });
    }
    await trace.registerSensor(truckSensor, { from: dc });
    await trace.issueCredential(plant, 'halal', web3.utils.keccak256('certificate.pdf'), now + 365 * DAY, { from: certifier });

    await trace.registerBeefLot('A-BEEF-1', ['NAIT-001', 'NAIT-002'], 1100 * KG, { from: farmA });
    await trace.transferLot(await id('A-BEEF-1'), plant, { from: farmA });
    await trace.registerBeefLot('B-BEEF-1', ['NAIT-100'], 500 * KG, { from: farmB });
    await trace.transferLot(await id('B-BEEF-1'), plant, { from: farmB });
    await trace.registerLambLot('A-LAMB-1', 'ASD-2026-0042', 12, 540 * KG, { from: farmA });

    await trace.slaughter(await id('A-BEEF-1'), ['C-1', 'C-2'], [300 * KG, 300 * KG], true, { from: plant });
    await trace.slaughter(await id('B-BEEF-1'), ['C-9'], [260 * KG], false, { from: plant });
    await trace.splitLot(await id('C-1'), [product('P-STEAK-1', 'Scotch fillet', 20), product('P-TRIM-1', 'Beef trim', 60)], { from: plant });
    await trace.mergeLots([await id('P-TRIM-1'), await id('C-9')], product('P-MINCE-1', 'Beef mince', 250), { from: plant });
    for (const ref of ['P-STEAK-1', 'P-MINCE-1']) {
      await trace.transferLot(await id(ref), dc, { from: plant });
      await trace.transferLot(await id(ref), store, { from: dc });
    }

    console.log(`MeatTrace at ${trace.address}`);
    console.log('Roles:');
    const labels = ['admin', 'farm A', 'farm B', 'plant', 'certifier', 'DC', 'store', 'regulator', 'truck sensor'];
    labels.forEach((l, i) => console.log(`  ${i}  ${l.padEnd(13)} ${accounts[i]}`));
    console.log('Lots ready to scan: P-STEAK-1 (halal), P-MINCE-1 (not halal), C-2 (carcass), A-LAMB-1 (live lambs at farm A)');
    callback();
  } catch (err) {
    callback(err);
  }
};
