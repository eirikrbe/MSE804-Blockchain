'use strict';

/* global ethers */

const ROLES = ['No role', 'Admin', 'Farm', 'Processor', 'Logistics', 'Retailer', 'Certifier', 'Regulator'];
const SPECIES = ['Beef', 'Lamb'];
const KINDS = ['Live animals', 'Carcass', 'Product'];
const STATUS = ['OK', 'Quarantined', 'Recalled'];

let contract = null;
let provider = null;

const $ = id => document.getElementById(id);
const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
const kg = grams => `${(Number(grams) / 1000).toLocaleString()} kg`;
const list = text => text.split(',').map(s => s.trim()).filter(Boolean);
const toGrams = value => Math.round(Number(value) * 1000);

function log(message, kind = 'info') {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  $('log').prepend(li);
}

/** The contract's own revert message, wherever ethers put it. */
function reason(err) {
  // MetaMask wraps Ganache's error as "Internal JSON-RPC error." and nests the real one under data.
  const rpc = err?.info?.error?.data || err?.error?.data;
  const vm = rpc?.message?.match(/revert (.+)$/)?.[1];
  return err?.reason || rpc?.data?.reason || rpc?.reason || vm || err?.info?.error?.message || err?.shortMessage || err?.message || String(err);
}

async function chainTime() {
  return (await provider.getBlock('latest')).timestamp;
}

async function connect() {
  if (!window.ethereum) {
    log('MetaMask was not found. Install it, then reload this page.', 'error');
    return;
  }
  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    const signer = await provider.getSigner();
    const account = await signer.getAddress();
    const netId = await provider.send('net_version', []);
    const artifact = await (await fetch('MeatTrace.json')).json();
    const deployed = artifact.networks[netId];
    if (!deployed) {
      log(`MeatTrace is not deployed on network ${netId}. Run "migrate" in truffle develop and pick that network in MetaMask.`, 'error');
      return;
    }
    contract = new ethers.Contract(deployed.address, artifact.abi, signer);
    const p = await contract.participants(account);
    const owner = await contract.sensorOwner(account);
    let role = ROLES[Number(p.role)];
    if (Number(p.role) !== 0) {
      role += ` · ${p.name}`;
    } else if (owner !== ethers.ZeroAddress) {
      role = 'Sensor';
    }
    $('account').textContent = short(account);
    $('role').textContent = role;
    $('connect').textContent = 'Connected';
    log(`Connected as ${short(account)} (${role}) to MeatTrace at ${short(deployed.address)}`);
  } catch (err) {
    log(reason(err), 'error');
  }
}

async function scan(ref) {
  if (!contract) {
    log('Connect MetaMask first.', 'error');
    return;
  }
  try {
    const id = await contract.idOf(ref);
    const [lot, sale, ancestors, batches] = await Promise.all([
      contract.getLot(id), contract.checkSaleable(id), contract.getAncestors(id), contract.getColdChain(id),
    ]);
    const verdict = $('verdict');
    if (Number(lot.kind) !== 2) {
      verdict.className = 'verdict neutral';
      verdict.textContent = `${KINDS[Number(lot.kind)]}: not a retail product`;
    } else if (sale.saleable) {
      verdict.className = 'verdict ok';
      verdict.textContent = 'OK to sell';
    } else {
      verdict.className = 'verdict stop';
      verdict.textContent = `Do not sell: ${sale.reason}`;
    }

    const farms = await Promise.all(lot.originFarms.map(async a => (await contract.participants(a)).name || short(a)));
    const holder = await contract.participants(lot.custodian);
    const excursions = batches.filter(b => b.excursion).length;
    let halal = 'No halal claim';
    if (sale.halalClaim) {
      halal = sale.halalValid ? 'Halal: certificate valid' : 'Halal claim invalid: certificate revoked';
    }
    const facts = [
      ['Lot', `${lot.ref} (${KINDS[Number(lot.kind)]})`],
      ['Product', lot.product || '—'],
      ['Species', SPECIES[Number(lot.species)]],
      ['Status', STATUS[Number(lot.status)] + (lot.statusReason ? `: ${lot.statusReason}` : '')],
      ['Weight', kg(lot.weightGrams)],
      ['Use-by', Number(lot.useBy) ? new Date(Number(lot.useBy) * 1000).toLocaleDateString() : '—'],
      ['Halal', halal],
      ['From farms', farms.join(', ')],
      ['Held by', holder.name || short(lot.custodian)],
      ['Cold chain', `${batches.length} sensor batch${batches.length === 1 ? '' : 'es'}, ${excursions} excursion${excursions === 1 ? '' : 's'}`],
    ];
    $('facts').replaceChildren(...facts.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }));

    const chain = await Promise.all(ancestors.slice(1).map(a => contract.getLot(a)));
    $('chain').replaceChildren(...(chain.length ? chain : [null]).map(l => {
      const li = document.createElement('li');
      li.textContent = l ? `${l.ref}: ${KINDS[Number(l.kind)]}${l.product ? ` (${l.product})` : ''}` : 'Nothing: this lot is where the chain starts';
      return li;
    }));
    $('result').hidden = false;
  } catch (err) {
    $('result').hidden = true;
    log(`Scan ${ref}: ${reason(err)}`, 'error');
  }
}

const actions = {
  registerParticipant: f => contract.registerParticipant(f.address, Number(f.role), f.name, f.nzbn),
  registerBeefLot: f => contract.registerBeefLot(f.ref, list(f.nait), toGrams(f.kg)),
  registerLambLot: f => contract.registerLambLot(f.ref, f.asd, Number(f.head), toGrams(f.kg)),
  transferLot: async f => contract.transferLot(await contract.idOf(f.ref), f.to),
  issueCredential: async f => contract.issueCredential(f.processor, 'halal', ethers.id(f.document || 'certificate'),
    (await chainTime()) + Number(f.days) * 86400),
  slaughter: async f => contract.slaughter(await contract.idOf(f.ref), list(f.carcasses), list(f.weights).map(toGrams), f.halal === 'on'),
  splitLot: async f => contract.splitLot(await contract.idOf(f.ref), [{
    ref: f.product,
    gtin: f.gtin,
    product: f.name,
    weightGrams: toGrams(f.kg),
    useBy: (await chainTime()) + Number(f.days) * 86400,
    maxTempTenths: Math.round(Number(f.maxTemp) * 10),
  }]),
  recall: async f => contract.recall(await contract.idOf(f.ref), f.reason),
  releaseQuarantine: async f => contract.releaseQuarantine(await contract.idOf(f.ref), f.reason),
};

async function submitAction(form) {
  if (!contract) {
    log('Connect MetaMask first.', 'error');
    return;
  }
  const name = form.dataset.action;
  const fields = Object.fromEntries(new FormData(form).entries());
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const tx = await actions[name](fields);
    log(`${name}: sent ${short(tx.hash)}, waiting for the block…`);
    const receipt = await tx.wait();
    log(`${name}: confirmed in block ${receipt.blockNumber} (gas ${receipt.gasUsed})`, 'ok');
    if (fields.ref || fields.product) {
      await scan(fields.product || fields.ref);
    }
  } catch (err) {
    log(`${name}: ${reason(err)}`, 'error');
  } finally {
    button.disabled = false;
  }
}

$('connect').addEventListener('click', connect);
$('scanForm').addEventListener('submit', e => {
  e.preventDefault();
  scan($('scanRef').value.trim());
});
document.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
  $('scanRef').value = chip.dataset.ref;
  scan(chip.dataset.ref);
}));
document.querySelectorAll('form[data-action]').forEach(form => form.addEventListener('submit', e => {
  e.preventDefault();
  submitAction(form);
}));
if (window.ethereum) {
  window.ethereum.on('accountsChanged', connect);
  window.ethereum.on('chainChanged', () => window.location.reload());
}
