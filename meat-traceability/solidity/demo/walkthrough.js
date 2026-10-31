/*
 * Walk-through of the Solidity prototype on Truffle's built-in Ganache, with
 * the gas each step costs.
 *
 *   truffle test demo/walkthrough.js
 *
 * Every business below is fictional.
 */
const MeatTrace = artifacts.require('MeatTrace');
const { summarise } = require('../../chaincode/src/merkle');

const Role = { Farm: 2, Processor: 3, Logistics: 4, Retailer: 5, Certifier: 6, Regulator: 7 };
const DAY = 24 * 60 * 60;
const KG = 1000;

contract('MeatTrace walk-through', accounts => {
  const [admin, farmA, farmB, plant, certifier, dc, store, regulator, truckSensor] = accounts;

  it('farm → plant → DC → store, with an excursion and a recall', async () => {
    const gas = [];
    const run = async (label, txPromise) => {
      const tx = await txPromise;
      gas.push([label, tx.receipt.gasUsed]);
      return tx;
    };
    const now = async () => Number((await web3.eth.getBlock('latest')).timestamp);
    const step = (n, text) => console.log(`\n      ${n}. ${text}`);

    const deployTx = await MeatTrace.new({ from: admin });
    const trace = deployTx;
    const receipt = await web3.eth.getTransactionReceipt(trace.transactionHash);
    gas.push(['deploy contract', receipt.gasUsed]);
    const id = async ref => (await trace.idOf(ref)).toNumber();

    step(1, 'The consortium admin onboards seven businesses; the DC registers a truck sensor');
    const reg = (a, r, n) => run(`registerParticipant (${n})`, trace.registerParticipant(a, r, n, '9429000000000', { from: admin }));
    await reg(farmA, Role.Farm, 'Example Station A');
    await reg(farmB, Role.Farm, 'Example Farm B');
    await reg(plant, Role.Processor, 'Example Meat Processor');
    await reg(certifier, Role.Certifier, 'Example Halal Certifier');
    await reg(dc, Role.Logistics, 'Retailer DC Auckland');
    await reg(store, Role.Retailer, 'Store 101');
    await reg(regulator, Role.Regulator, 'Food regulator');
    await run('registerSensor', trace.registerSensor(truckSensor, { from: dc }));

    step(2, 'The certifier issues a halal credential to the plant');
    await run('issueCredential', trace.issueCredential(plant, 'halal', web3.utils.keccak256('certificate.pdf'), (await now()) + 365 * DAY, { from: certifier }));

    step(3, 'Farms send cattle to the plant (NAIT numbers stored as a hash)');
    await run('registerBeefLot (2 animals)', trace.registerBeefLot('A-BEEF-1', ['NAIT-001', 'NAIT-002'], 1100 * KG, { from: farmA }));
    await run('transferLot', trace.transferLot(await id('A-BEEF-1'), plant, { from: farmA }));
    await run('registerBeefLot (1 animal)', trace.registerBeefLot('B-BEEF-1', ['NAIT-100'], 500 * KG, { from: farmB }));
    await trace.transferLot(await id('B-BEEF-1'), plant, { from: farmB });

    step(4, 'Halal slaughter of farm A cattle, standard slaughter of farm B cattle');
    await run('slaughter (2 carcasses, halal)', trace.slaughter(await id('A-BEEF-1'), ['C-1', 'C-2'], [300 * KG, 300 * KG], true, { from: plant }));
    await run('slaughter (1 carcass)', trace.slaughter(await id('B-BEEF-1'), ['C-9'], [260 * KG], false, { from: plant }));

    step(5, 'Cutting and mince: mixing halal trim with non-halal beef drops the claim');
    const product = async (ref, name, kg) => ({ ref, gtin: '9412345000017', product: name, weightGrams: kg * KG, useBy: (await now()) + 10 * DAY, maxTempTenths: 40 });
    await run('splitLot (2 products)', trace.splitLot(await id('C-1'), [await product('P-STEAK-1', 'Scotch fillet', 20), await product('P-TRIM-1', 'Beef trim', 60)], { from: plant }));
    const merge = await run('mergeLots (2 inputs)', trace.mergeLots([await id('P-TRIM-1'), await id('C-9')], await product('P-MINCE-1', 'Beef mince', 250), { from: plant }));
    const dropped = merge.logs.find(l => l.event === 'Merged').args.halalDroppedByMixing;
    console.log(`         steak halal: yes · mince halal: ${dropped ? 'no (mixed inputs)' : 'yes'}`);

    step(6, 'Shipping: the truck sensor reports a warm hour for the steak');
    for (const ref of ['P-STEAK-1', 'P-MINCE-1']) {
      await trace.transferLot(await id(ref), dc, { from: plant });
    }
    const start = await now();
    const readings = [3, 7, 8, 8, 7, 6, 3].map((tempC, i) => ({ ts: new Date((start + i * 600) * 1000).toISOString(), tempC }));
    const s = summarise(readings, 4);
    const batch = {
      windowStart: start, windowEnd: start + 3600, count: s.count, merkleRoot: '0x' + s.merkleRoot,
      minTenths: s.minC * 10, maxTenths: s.maxC * 10, minutesAbove: s.minutesAbove,
    };
    const cc = await run('submitColdChainBatch (7 readings)', trace.submitColdChainBatch(await id('P-STEAK-1'), batch, { from: truckSensor }));
    const excursion = cc.logs.find(l => l.event === 'ColdChainRecorded').args.excursion;
    console.log(`         ${s.count} readings, max ${s.maxC} °C, ${s.minutesAbove} min above 4 °C → excursion: ${excursion}`);

    step(7, 'The DC delivers the mince to Store 101; checkout scans both products');
    await trace.transferLot(await id('P-MINCE-1'), store, { from: dc });
    for (const ref of ['P-STEAK-1', 'P-MINCE-1']) {
      const c = await trace.checkSaleable(await id(ref));
      console.log(`         ${ref}: saleable=${c.saleable}${c.reason ? ` (${c.reason})` : ''}`);
    }

    step(8, 'A lab finds E. coli in carcass C-1: one recall call finds every affected pack');
    const r = await run('recall (4 lots)', trace.recall(await id('C-1'), 'E. coli detected in carcass sample', { from: plant }));
    for (const lotId of r.logs.find(l => l.event === 'Recalled').args.lots) {
      const l = await trace.getLot(lotId);
      const holder = [farmA, farmB, plant, dc, store].indexOf(l.custodian);
      console.log(`         ${l.ref.padEnd(10)} ${(l.product || 'carcass').padEnd(14)} now held by ${['farm A', 'farm B', 'plant', 'DC', 'Store 101'][holder]}`);
    }
    const after = await trace.checkSaleable(await id('P-MINCE-1'));
    console.log(`         checkout scan of P-MINCE-1 → saleable=${after.saleable} (${after.reason})`);

    step(9, 'Gas used per step');
    for (const [label, used] of gas.filter(([l]) => !l.startsWith('registerParticipant ('))) {
      console.log(`         ${label.padEnd(36)} ${String(used).padStart(9)}`);
    }
    const regs = gas.filter(([l]) => l.startsWith('registerParticipant ('));
    console.log(`         ${'registerParticipant (average)'.padEnd(36)} ${String(Math.round(regs.reduce((a, [, g]) => a + g, 0) / regs.length)).padStart(9)}`);
  });
});
