const crypto = require('crypto');
const MeatTrace = artifacts.require('MeatTrace');
const { merkleRoot, merkleProof, canonical, summarise } = require('../../chaincode/src/merkle');

const Role = { Farm: 2, Processor: 3, Logistics: 4, Retailer: 5, Certifier: 6, Regulator: 7 };
const Status = { Ok: '0', Quarantined: '1', Recalled: '2' };
const DAY = 24 * 60 * 60;
const NZBN = '9429000000000';
const KG = 1000;

async function expectRevert(promise, fragment) {
  try {
    await promise;
  } catch (e) {
    assert.include(e.message, fragment, `reverted for another reason: ${e.message}`);
    return;
  }
  assert.fail(`expected a revert containing "${fragment}"`);
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    web3.currentProvider.send({ jsonrpc: '2.0', method, params, id: Date.now() }, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

async function increaseTime(seconds) {
  await rpc('evm_increaseTime', [seconds]);
  await rpc('evm_mine', []);
}

const now = async () => Number((await web3.eth.getBlock('latest')).timestamp);
const leafHash = r => '0x' + crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from(canonical(r))])).digest('hex');
const tenths = c => Math.round(c * 10);

/** A sensor batch in the contract's units, built the same way the off-chain gateway would. */
function batchFrom(temps, startSec, limitC) {
  const readings = temps.map((tempC, i) => ({ ts: new Date((startSec + i * 600) * 1000).toISOString(), tempC }));
  const s = summarise(readings, limitC);
  return {
    readings,
    batch: {
      windowStart: Math.floor(Date.parse(s.windowStart) / 1000),
      windowEnd: Math.floor(Date.parse(s.windowEnd) / 1000),
      count: s.count,
      merkleRoot: '0x' + s.merkleRoot,
      minTenths: tenths(s.minC),
      maxTenths: tenths(s.maxC),
      minutesAbove: s.minutesAbove,
    },
  };
}

contract('MeatTrace', accounts => {
  const [admin, farmA, farmB, plant, plant2, certifier, dc, store, regulator, truckSensor] = accounts;
  let trace;

  const id = async ref => (await trace.idOf(ref)).toNumber();
  const lot = async ref => trace.getLot(await id(ref));
  const product = async (ref, name, kg) => ({
    ref, gtin: '9412345000017', product: name, weightGrams: kg * KG, useBy: (await now()) + 10 * DAY, maxTempTenths: 40,
  });

  /** Farm A's two cattle become two halal carcasses; carcass C-1 is cut into steak and trim. */
  async function beefToCuts() {
    await trace.registerBeefLot('A-BEEF-1', ['NAIT-001', 'NAIT-002'], 1100 * KG, { from: farmA });
    await trace.transferLot(await id('A-BEEF-1'), plant, { from: farmA });
    await trace.issueCredential(plant, 'halal', web3.utils.keccak256('certificate pdf'), (await now()) + 365 * DAY, { from: certifier });
    await trace.slaughter(await id('A-BEEF-1'), ['C-1', 'C-2'], [300 * KG, 300 * KG], true, { from: plant });
    await trace.splitLot(await id('C-1'), [await product('P-STEAK-1', 'Scotch fillet', 20), await product('P-TRIM-1', 'Beef trim', 60)], { from: plant });
  }

  /** Farm B's animal is slaughtered at the same plant without a halal claim. */
  async function nonHalalCarcass() {
    await trace.registerBeefLot('B-BEEF-1', ['NAIT-100'], 500 * KG, { from: farmB });
    await trace.transferLot(await id('B-BEEF-1'), plant, { from: farmB });
    await trace.slaughter(await id('B-BEEF-1'), ['C-9'], [260 * KG], false, { from: plant });
  }

  beforeEach(async () => {
    assert.isAtLeast(accounts.length, 10, 'needs 10 Ganache accounts');
    trace = await MeatTrace.new({ from: admin });
    const reg = (acct, role, name) => trace.registerParticipant(acct, role, name, NZBN, { from: admin });
    await reg(farmA, Role.Farm, 'Farm A');
    await reg(farmB, Role.Farm, 'Farm B');
    await reg(plant, Role.Processor, 'Plant 1');
    await reg(plant2, Role.Processor, 'Plant 2');
    await reg(certifier, Role.Certifier, 'Halal Certifier');
    await reg(dc, Role.Logistics, 'DC Auckland');
    await reg(store, Role.Retailer, 'Store 101');
    await reg(regulator, Role.Regulator, 'Regulator');
    await trace.registerSensor(truckSensor, { from: dc });
  });

  describe('participants', () => {
    it('only the consortium admin onboards businesses, with a 13-digit NZBN', async () => {
      await expectRevert(trace.registerParticipant(store, Role.Farm, 'x', NZBN, { from: farmA }), 'only the consortium admin');
      await expectRevert(trace.registerParticipant(plant, Role.Farm, 'x', '123', { from: admin }), 'already registered');
      const fresh = await MeatTrace.new({ from: admin });
      await expectRevert(fresh.registerParticipant(farmA, Role.Farm, 'x', '123', { from: admin }), 'nzbn must be 13 digits');
    });

    it('a sensor address cannot also be a participant', async () => {
      await expectRevert(trace.registerParticipant(truckSensor, Role.Farm, 'x', NZBN, { from: admin }), 'already registered');
    });
  });

  describe('animal lots', () => {
    it('beef needs NAIT numbers, stored only as a hash', async () => {
      await expectRevert(trace.registerBeefLot('A-3', [], 900 * KG, { from: farmA }), 'NAIT');
      await trace.registerBeefLot('A-3', ['NAIT-007', 'NAIT-008'], 900 * KG, { from: farmA });
      const l = await lot('A-3');
      assert.equal(l.headCount, '2');
      assert.equal(l.identifiersHash, web3.eth.abi.encodeParameter('bytes32', web3.utils.keccak256(web3.eth.abi.encodeParameter('string[]', ['NAIT-007', 'NAIT-008']))));
      assert.notInclude(JSON.stringify(l), 'NAIT-007');
    });

    it('lamb needs an ASD reference and head count (sheep are not in NAIT)', async () => {
      await expectRevert(trace.registerLambLot('A-4', '', 10, 400 * KG, { from: farmA }), 'ASD');
      await trace.registerLambLot('A-4', 'ASD-77', 10, 400 * KG, { from: farmA });
      assert.equal((await lot('A-4')).species, '1');
    });

    it('only farms register animals', async () => {
      await expectRevert(trace.registerLambLot('A-5', 'ASD-1', 1, 40 * KG, { from: plant }), 'only farms');
    });
  });

  describe('custody', () => {
    it('only the holder transfers, and only to a business that holds goods', async () => {
      await trace.registerLambLot('A-6', 'ASD-6', 10, 450 * KG, { from: farmA });
      await expectRevert(trace.transferLot(await id('A-6'), plant, { from: farmB }), 'does not hold');
      await expectRevert(trace.transferLot(await id('A-6'), certifier, { from: farmA }), 'cannot take custody');
      await trace.transferLot(await id('A-6'), plant, { from: farmA });
      assert.equal((await lot('A-6')).custodian, plant);
    });
  });

  describe('credentials', () => {
    it('only certifiers issue, and only to processors', async () => {
      const exp = (await now()) + 30 * DAY;
      await expectRevert(trace.issueCredential(plant, 'halal', web3.utils.keccak256('x'), exp, { from: plant }), 'only certifiers');
      await expectRevert(trace.issueCredential(farmA, 'halal', web3.utils.keccak256('x'), exp, { from: certifier }), 'issued to processors');
    });

    it('only the issuing certifier can revoke', async () => {
      await trace.issueCredential(plant, 'halal', web3.utils.keccak256('x'), (await now()) + 30 * DAY, { from: certifier });
      await expectRevert(trace.revokeCredential(1, { from: plant }), 'only the issuing certifier');
      await trace.revokeCredential(1, { from: certifier });
      assert.equal((await trace.getCredential(1)).revoked, true);
    });
  });

  describe('slaughter, cutting and halal', () => {
    it('halal slaughter needs an active halal credential', async () => {
      await trace.registerBeefLot('A-7', ['N7'], 500 * KG, { from: farmA });
      await trace.transferLot(await id('A-7'), plant2, { from: farmA });
      await expectRevert(trace.slaughter(await id('A-7'), ['C-7'], [250 * KG], true, { from: plant2 }), 'no active halal credential');
    });

    it('an expired credential cannot be used for a new halal slaughter', async () => {
      await trace.issueCredential(plant2, 'halal', web3.utils.keccak256('x'), (await now()) + 5 * DAY, { from: certifier });
      await increaseTime(6 * DAY);
      await trace.registerBeefLot('A-8', ['N8'], 500 * KG, { from: farmA });
      await trace.transferLot(await id('A-8'), plant2, { from: farmA });
      await expectRevert(trace.slaughter(await id('A-8'), ['C-8'], [250 * KG], true, { from: plant2 }), 'no active halal credential');
    });

    it('the halal claim travels from slaughter to each retail cut', async () => {
      await beefToCuts();
      const steak = await lot('P-STEAK-1');
      assert.lengthOf(steak.halalCredentials, 1);
      assert.deepEqual(steak.parents, [String(await id('C-1'))]);
      assert.deepEqual(steak.originFarms, [farmA]);
    });

    it('carcasses cannot outweigh the animals, and cuts cannot outweigh the carcass', async () => {
      await trace.registerBeefLot('A-9', ['N9'], 500 * KG, { from: farmA });
      await trace.transferLot(await id('A-9'), plant, { from: farmA });
      await expectRevert(trace.slaughter(await id('A-9'), ['C-90'], [600 * KG], false, { from: plant }), 'cannot weigh more');
      await trace.slaughter(await id('A-9'), ['C-90'], [260 * KG], false, { from: plant });
      await expectRevert(trace.splitLot(await id('C-90'), [await product('P-90', 'Mince', 300)], { from: plant }), 'cannot weigh more');
    });

    it('a lot can only be processed once', async () => {
      await beefToCuts();
      await expectRevert(trace.splitLot(await id('C-1'), [await product('P-X', 'Extra', 1)], { from: plant }), 'already been processed');
    });

    it('a failed transaction leaves nothing behind', async () => {
      await trace.registerBeefLot('A-10', ['N10'], 500 * KG, { from: farmA });
      await trace.transferLot(await id('A-10'), plant, { from: farmA });
      await expectRevert(trace.slaughter(await id('A-10'), ['C-100', 'C-101'], [200 * KG, 0], false, { from: plant }), 'weight must be positive');
      await expectRevert(trace.idOf('C-100'), 'lot does not exist');
      assert.equal((await lot('A-10')).consumed, false);
    });
  });

  describe('mixing', () => {
    it('mince from a halal and a non-halal carcass loses the halal claim', async () => {
      await beefToCuts();
      await nonHalalCarcass();
      const tx = await trace.mergeLots([await id('P-TRIM-1'), await id('C-9')], await product('P-MINCE-1', 'Beef mince', 250), { from: plant });
      const merged = tx.logs.find(l => l.event === 'Merged');
      assert.equal(merged.args.halalDroppedByMixing, true);
      const mince = await lot('P-MINCE-1');
      assert.lengthOf(mince.halalCredentials, 0);
      assert.sameMembers(mince.originFarms, [farmA, farmB]);
    });

    it('beef and lamb cannot be merged', async () => {
      await beefToCuts();
      await trace.registerLambLot('B-LAMB-1', 'ASD-9', 5, 200 * KG, { from: farmB });
      await trace.transferLot(await id('B-LAMB-1'), plant, { from: farmB });
      await trace.slaughter(await id('B-LAMB-1'), ['L-1'], [90 * KG], true, { from: plant });
      await expectRevert(trace.mergeLots([await id('P-TRIM-1'), await id('L-1')], await product('P-MIX', 'Mix', 100), { from: plant }),
        'different species');
    });
  });

  describe('cold chain', () => {
    it('a sensor can only report on lots its owner holds', async () => {
      await beefToCuts();
      const { batch } = batchFrom([2, 2, 3], await now(), 4);
      await expectRevert(trace.submitColdChainBatch(await id('P-STEAK-1'), batch, { from: truckSensor }), 'does not hold');
      await expectRevert(trace.submitColdChainBatch(await id('P-STEAK-1'), batch, { from: store }), 'sensor is not registered');
    });

    it('a long excursion quarantines the lot until the regulator releases it', async () => {
      await beefToCuts();
      await trace.transferLot(await id('P-STEAK-1'), dc, { from: plant });
      const { batch } = batchFrom([3, 7, 8, 8, 7, 6, 3], await now(), 4);
      assert.equal(batch.minutesAbove, 50);
      await trace.submitColdChainBatch(await id('P-STEAK-1'), batch, { from: truckSensor });
      assert.equal((await lot('P-STEAK-1')).status, Status.Quarantined);
      assert.equal((await trace.checkSaleable(await id('P-STEAK-1'))).saleable, false);
      await expectRevert(trace.releaseQuarantine(await id('P-STEAK-1'), 'checked and fine', { from: dc }), 'only the regulator');
      await trace.releaseQuarantine(await id('P-STEAK-1'), 'Core temperature tested within limits', { from: regulator });
      assert.equal((await trace.checkSaleable(await id('P-STEAK-1'))).saleable, true);
    });

    it('a short spike within the allowed minutes does not quarantine', async () => {
      await beefToCuts();
      await trace.transferLot(await id('P-STEAK-1'), dc, { from: plant });
      const { batch } = batchFrom([3, 6, 3, 3], await now(), 4);
      await trace.submitColdChainBatch(await id('P-STEAK-1'), batch, { from: truckSensor });
      assert.equal((await lot('P-STEAK-1')).status, Status.Ok);
    });

    it('the contract verifies a reading against the Merkle root built off-chain', async () => {
      const { readings } = batchFrom([2, 3, 4, 3, 2], await now(), 4);
      const root = '0x' + merkleRoot(readings);
      const proof = merkleProof(readings, 3);
      const hashes = proof.map(p => '0x' + p.hash);
      const lefts = proof.map(p => p.left);
      assert.equal(await trace.verifyReading(root, leafHash(readings[3]), hashes, lefts), true);
      const tampered = Object.assign({}, readings[3], { tempC: 1 });
      assert.equal(await trace.verifyReading(root, leafHash(tampered), hashes, lefts), false);
    });
  });

  describe('recall', () => {
    it('recalling one carcass reaches every product made from it, wherever it is', async () => {
      await beefToCuts();
      await nonHalalCarcass();
      await trace.mergeLots([await id('P-TRIM-1'), await id('C-9')], await product('P-MINCE-1', 'Beef mince', 250), { from: plant });
      await trace.transferLot(await id('P-MINCE-1'), dc, { from: plant });
      await trace.transferLot(await id('P-MINCE-1'), store, { from: dc });
      const tx = await trace.recall(await id('C-1'), 'E. coli detected in carcass sample', { from: plant });
      const affected = tx.logs.find(l => l.event === 'Recalled').args.lots.map(String);
      const expected = await Promise.all(['C-1', 'P-STEAK-1', 'P-TRIM-1', 'P-MINCE-1'].map(async r => String(await id(r))));
      assert.sameMembers(affected, expected);
      assert.equal((await lot('P-MINCE-1')).custodian, store);
      assert.equal((await trace.checkSaleable(await id('P-MINCE-1'))).saleable, false);
      assert.equal((await lot('C-2')).status, Status.Ok);
    });

    it('a processor cannot recall product it never handled; the regulator can', async () => {
      await beefToCuts();
      await expectRevert(trace.recall(await id('C-1'), 'suspected contamination', { from: plant2 }), 'only the regulator can recall');
      const tx = await trace.recall(await id('A-BEEF-1'), 'Residue found in herd testing', { from: regulator });
      assert.lengthOf(tx.logs.find(l => l.event === 'Recalled').args.lots, 5);
    });

    it('a lot cannot be recalled twice, but its parent still can', async () => {
      await beefToCuts();
      await trace.recall(await id('C-1'), 'E. coli detected in carcass sample', { from: plant });
      await expectRevert(trace.recall(await id('C-1'), 'Second recall of the same lot', { from: regulator }), 'lot is already recalled');
      await expectRevert(trace.recall(await id('P-STEAK-1'), 'Product made from the recalled carcass', { from: regulator }), 'lot is already recalled');
      const tx = await trace.recall(await id('A-BEEF-1'), 'Residue found in herd testing', { from: regulator });
      assert.lengthOf(tx.logs.find(l => l.event === 'Recalled').args.lots, 5);
      assert.equal((await lot('C-2')).status, Status.Recalled);
    });

    it('a later recall keeps the first reason on lots that were already recalled', async () => {
      await beefToCuts();
      await nonHalalCarcass();
      await trace.mergeLots([await id('P-TRIM-1'), await id('C-9')], await product('P-MINCE-1', 'Beef mince', 250), { from: plant });
      await trace.recall(await id('C-1'), 'E. coli detected in carcass sample', { from: plant });
      await trace.recall(await id('C-9'), 'Foreign matter found on carcass', { from: plant });
      assert.equal((await lot('P-MINCE-1')).statusReason, 'E. coli detected in carcass sample');
      assert.equal((await lot('C-9')).statusReason, 'Foreign matter found on carcass');
    });

    it('a recalled lot cannot be moved on', async () => {
      await beefToCuts();
      await trace.recall(await id('P-STEAK-1'), 'Labelling error found', { from: plant });
      await expectRevert(trace.transferLot(await id('P-STEAK-1'), dc, { from: plant }), 'recalled lots cannot be moved');
    });
  });

  describe('point of sale', () => {
    it('a revoked halal certificate makes the claim invalid at the checkout', async () => {
      await beefToCuts();
      await trace.revokeCredential(1, { from: certifier });
      const c = await trace.checkSaleable(await id('P-STEAK-1'));
      assert.equal(c.halalClaim, true);
      assert.equal(c.halalValid, false);
      assert.equal(c.saleable, false);
    });

    it('a certificate that expires after slaughter still covers the product', async () => {
      await trace.issueCredential(plant2, 'halal', web3.utils.keccak256('x'), (await now()) + 2 * DAY, { from: certifier });
      await trace.registerLambLot('A-11', 'ASD-11', 3, 120 * KG, { from: farmA });
      await trace.transferLot(await id('A-11'), plant2, { from: farmA });
      await trace.slaughter(await id('A-11'), ['L-11'], [55 * KG], true, { from: plant2 });
      await trace.splitLot(await id('L-11'), [await product('P-LAMB-11', 'Lamb rack', 10)], { from: plant2 });
      await increaseTime(3 * DAY);
      const c = await trace.checkSaleable(await id('P-LAMB-11'));
      assert.equal(c.halalValid, true);
      assert.equal(c.saleable, true);
    });

    it('a product past its use-by date is not saleable', async () => {
      await beefToCuts();
      await increaseTime(11 * DAY);
      const c = await trace.checkSaleable(await id('P-STEAK-1'));
      assert.equal(c.saleable, false);
      assert.equal(c.reason, 'past its use-by date');
    });
  });

  describe('provenance', () => {
    it('walks back from a pack of mince to both farms', async () => {
      await beefToCuts();
      await nonHalalCarcass();
      await trace.mergeLots([await id('P-TRIM-1'), await id('C-9')], await product('P-MINCE-1', 'Beef mince', 250), { from: plant });
      const up = (await trace.getAncestors(await id('P-MINCE-1'))).map(String);
      const expected = await Promise.all(['P-MINCE-1', 'P-TRIM-1', 'C-9', 'C-1', 'B-BEEF-1', 'A-BEEF-1'].map(async r => String(await id(r))));
      assert.sameMembers(up, expected);
    });
  });
});
