/* global document, window, sessionStorage */
'use strict';

const SCOPES = {
    clinician: ['records:read', 'records:write', 'details:read', 'wearable:read'],
    lab: ['records:read', 'lab:write', 'details:read'],
    trainer: ['wearable:read', 'details:read'],
};

const $ = sel => document.querySelector(sel);
let session = null;
let providers = [];
let selectedPatient = null;

function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
        if (k === 'onclick') {
            node.addEventListener('click', v);
        } else if (k === 'class') {
            node.className = v;
        } else {
            node.setAttribute(k, v);
        }
    });
    children.flat().forEach(c => node.append(c instanceof window.Node ? c : document.createTextNode(String(c))));
    return node;
}

function toast(message, isError) {
    const t = $('#toast');
    t.textContent = message;
    t.className = isError ? 'error' : '';
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
}

async function api(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, session ? { Authorization: `Bearer ${session.token}` } : {}),
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && session) {
        logout();
    }
    if (!res.ok) {
        throw new Error(data.error || res.statusText);
    }
    return data;
}

const guard = fn => async (...args) => {
    try {
        await fn(...args);
    } catch (e) {
        toast(e.message, true);
    }
};

const fmtDate = iso => (iso ? new Date(iso).toLocaleString() : '');
const providerName = id => (providers.find(p => p.id === id) || {}).displayName || id;

function show(title, obj) {
    $('#viewer-title').textContent = title;
    $('#viewer-body').textContent = JSON.stringify(obj, null, 2);
    $('#viewer').showModal();
}

// ------------------------------------------------------------ session

function logout() {
    session = null;
    sessionStorage.removeItem('hc-session');
    $('#app-view').hidden = true;
    $('#who').hidden = true;
    $('#login-view').hidden = false;
}

async function start() {
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#who').hidden = false;
    $('#who-name').textContent = session.user.displayName;
    $('#who-role').textContent = `${session.user.role} · ${session.user.mspId}`;
    providers = await api('GET', '/api/providers').catch(() => []);
    const isPatient = session.user.role === 'patient';
    $('#patient-view').hidden = !isPatient;
    $('#provider-view').hidden = isPatient;
    if (isPatient) {
        await refreshPatient();
    } else {
        document.querySelectorAll('.clinician-only').forEach(n => { n.hidden = session.user.role !== 'clinician'; });
        document.querySelectorAll('.lab-only').forEach(n => { n.hidden = session.user.role !== 'lab'; });
        await refreshProvider();
    }
}

$('#login-form').addEventListener('submit', guard(async e => {
    e.preventDefault();
    session = await api('POST', '/api/login', { username: $('#login-user').value, password: $('#login-pass').value });
    sessionStorage.setItem('hc-session', JSON.stringify(session));
    $('#login-pass').value = '';
    await start();
}));
$('#logout').addEventListener('click', logout);

// ------------------------------------------------------------ patient

async function refreshPatient() {
    const me = session.user.hcId;
    const [consents, records, log, wearables] = await Promise.all([
        api('GET', '/api/consents'),
        api('GET', `/api/patients/${me}/records`),
        api('GET', '/api/access-log'),
        api('GET', `/api/patients/${me}/wearables`),
    ]);
    const now = Date.now();
    $('#consent-table tbody').replaceChildren(...consents.map(c => {
        const expired = Date.parse(c.expiresAt) <= now;
        const status = c.status === 'active' && expired ? 'expired' : c.status;
        return el('tr', {},
            el('td', {}, providerName(c.providerId)),
            el('td', {}, c.docType === 'emergency' ? el('span', { class: 'chip emergency' }, 'emergency') : c.providerRole),
            el('td', {}, c.scopes.join(', ')),
            el('td', {}, fmtDate(c.expiresAt)),
            el('td', {}, el('span', { class: `chip ${status}` }, status)),
            el('td', {}, status === 'active'
                ? el('button', { class: 'small danger', onclick: guard(async () => {
                    await api('DELETE', `/api/consents/${c.providerId}`);
                    toast(`Access revoked for ${providerName(c.providerId)}`);
                    await refreshPatient();
                }) }, 'Revoke')
                : ''));
    }));
    if (!consents.length) {
        $('#consent-table tbody').replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Nobody has access yet.')));
    }

    $('#grant-provider').replaceChildren(...providers.map(p => el('option', { value: p.id }, `${p.displayName} (${p.role}, ${p.mspId})`)));
    renderScopeBoxes();
    if (!$('#grant-expiry').value) {
        $('#grant-expiry').value = new Date(now + 30 * 864e5).toISOString().slice(0, 10);
    }

    renderRecords($('#my-records'), records);
    $('#access-log').replaceChildren(...(log.length ? log.slice().sort((a, b) => b.at.localeCompare(a.at)).map(l => el('li', {},
        el('span', {}, `${fmtDate(l.at)} · ${providerName(l.accessorId)} · ${l.action}`, l.purpose ? ` (“${l.purpose}”)` : ''),
        el('span', { class: `chip ${l.via === 'emergency' ? 'emergency' : ''}` }, l.via))) : [el('li', { class: 'muted' }, 'No one has opened your records.')]));
    renderWearables($('#my-wearables'), wearables);
}

function renderScopeBoxes() {
    const p = providers.find(x => x.id === $('#grant-provider').value);
    const scopes = p ? SCOPES[p.role] : [];
    $('#grant-scopes').replaceChildren(el('legend', {}, 'Access'), ...scopes.map(s =>
        el('label', {}, el('input', { type: 'checkbox', value: s }), s)));
}
$('#grant-provider').addEventListener('change', renderScopeBoxes);

$('#grant-form').addEventListener('submit', guard(async e => {
    e.preventDefault();
    const scopes = [...document.querySelectorAll('#grant-scopes input:checked')].map(i => i.value);
    const expiresAt = new Date(`${$('#grant-expiry').value}T23:59:59`).toISOString();
    await api('POST', '/api/consents', { providerId: $('#grant-provider').value, scopes, expiresAt });
    toast('Access granted');
    await refreshPatient();
}));

$('#pair-form').addEventListener('submit', guard(async e => {
    e.preventDefault();
    await api('POST', '/api/wearables', { deviceId: $('#pair-id').value, name: $('#pair-name').value });
    toast('Wearable paired');
    $('#pair-form').reset();
}));

$('#details-form').addEventListener('submit', guard(async e => {
    e.preventDefault();
    await api('PUT', '/api/me/details', Object.fromEntries(new window.FormData(e.target)));
    toast('Details saved in the private data collection');
}));

$('#erase-details').addEventListener('click', guard(async () => {
    const r = await api('DELETE', '/api/me/details');
    $('#details-form').reset();
    toast(`Details purged${r.offChainDataKeyDestroyed ? ' and off-chain data key destroyed' : ''}`);
}));

// ------------------------------------------------------------ shared renderers

function renderRecords(list, records) {
    list.replaceChildren(...(records.length ? records.map(r => el('li', {},
        el('span', {}, el('strong', {}, r.title), ` · ${r.recordType} · v${r.version} · ${providerName(r.author)}`),
        el('span', { class: 'row' },
            el('button', { class: 'small', onclick: guard(async () => {
                const data = await api('GET', `/api/records/${r.recordId}?purpose=${encodeURIComponent('dashboard view')}`);
                show(r.title, data);
            }) }, 'Open'),
            el('button', { class: 'small ghost-dark', onclick: guard(async () => show(`History of ${r.title}`, await api('GET', `/api/records/${r.recordId}/history`))) }, 'History'))))
        : [el('li', { class: 'muted' }, 'No records.')]));
}

function renderWearables(list, batches) {
    list.replaceChildren(...(batches.length ? batches.slice().sort((a, b) => b.windowStart.localeCompare(a.windowStart)).map(b => el('li', {},
        el('span', {}, `${fmtDate(b.windowStart)} – ${new Date(b.windowEnd).toLocaleTimeString()} · ${b.count} readings · ♥ ${b.stats.heartRateMin}–${b.stats.heartRateMax} (avg ${b.stats.heartRateAvg}) · ${b.stats.steps} steps`),
        el('button', { class: 'small', onclick: guard(async () => show('Merkle proof for reading #0',
            await api('GET', `/api/patients/${b.patientId}/wearables/${b.batchId}/proof/0`))) }, 'Verify')))
        : [el('li', { class: 'muted' }, 'No wearable data.')]));
}

// ------------------------------------------------------------ providers

async function refreshProvider() {
    const consents = await api('GET', '/api/consents');
    const now = Date.now();
    const active = consents.filter(c => c && c.status === 'active' && Date.parse(c.expiresAt) > now);
    $('#patient-list').replaceChildren(...(active.length ? active.map(c => el('li', {
        class: c.patientId === selectedPatient ? 'active' : '',
        onclick: guard(() => selectPatient(c.patientId)),
    }, el('span', {}, c.patientId), el('span', { class: 'muted' }, c.scopes.join(', '))))
        : [el('li', { class: 'muted' }, 'No patient has granted you access.')]));
    if (selectedPatient) {
        await selectPatient(selectedPatient);
    }
}

async function selectPatient(patientId) {
    selectedPatient = patientId;
    document.querySelectorAll('#patient-list li').forEach(li => li.classList.toggle('active', li.firstChild.textContent === patientId));
    $('#patient-title').textContent = `Patient ${patientId}`;
    $('#patient-panel').hidden = false;
    const [records, wearables] = await Promise.all([
        api('GET', `/api/patients/${patientId}/records`).catch(e => { toast(e.message, true); return []; }),
        api('GET', `/api/patients/${patientId}/wearables`).catch(() => []),
    ]);
    renderRecords($('#patient-records'), records);
    renderWearables($('#patient-wearables'), wearables);
}

$('#record-form').addEventListener('submit', guard(async e => {
    e.preventDefault();
    const f = Object.fromEntries(new window.FormData(e.target));
    const { title } = f;
    delete f.title;
    await api('POST', `/api/patients/${selectedPatient}/records`, { title, content: Object.assign(f, { recordedAt: new Date().toISOString() }) });
    toast('Record encrypted off-chain; hash recorded on the ledger');
    await selectPatient(selectedPatient);
}));

$('#lab-form').addEventListener('submit', guard(async e => {
    e.preventDefault();
    const f = Object.fromEntries(new window.FormData(e.target));
    await api('POST', `/api/patients/${selectedPatient}/lab-results`, { testName: f.testName, content: { result: f.result, reportedAt: new Date().toISOString() } });
    toast('Lab result uploaded');
    await selectPatient(selectedPatient);
}));

$('#emergency-form').addEventListener('submit', guard(async e => {
    e.preventDefault();
    const patientId = $('#em-patient').value.trim();
    await api('POST', '/api/emergency', { patientId, reason: $('#em-reason').value });
    toast('Emergency access granted for 24 h. The patient will see this in their log.');
    await selectPatient(patientId);
}));

// ------------------------------------------------------------ boot

try {
    session = JSON.parse(sessionStorage.getItem('hc-session'));
} catch (e) {
    session = null;
}
if (session) {
    start().catch(() => logout());
}
