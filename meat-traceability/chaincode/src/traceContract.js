'use strict';

const { Contract } = require('fabric-contract-api');
const {
    ROLE, SELF_REGISTER_ROLES, CUSTODIAN_ROLES, SENSOR_OWNER_ROLES, RECALL_ROLES,
    SPECIES, KIND, STATUS, CREDENTIAL_TYPES, DEFAULT_MAX_TEMP_C, DEFAULT_MAX_EXCURSION_MINUTES,
} = require('./rules');

const ID_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const NZBN_PATTERN = /^\d{13}$/;
const GTIN_PATTERN = /^\d{8}$|^\d{12,14}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Beef and lamb traceability for a retailer-led consortium (prototype).
 *
 * Design:
 *  - Who the caller is comes from their certificate (MSP + tr.role + tr.id),
 *    never from transaction arguments.
 *  - Every lot (live animals, carcass, retail product) is its own ledger
 *    entry with links to its parents and children, so a recall can walk
 *    from one carcass to every pack of mince it ended up in.
 *  - A lot can be processed once (slaughtered, split or merged), so nobody
 *    can turn one carcass into more product than it held.
 *  - Halal is a certificate issued by a certifier to a processor. A product
 *    carries the claim only if every input came from a halal slaughter under
 *    a certificate that was active at the time; mixing drops the claim.
 *  - Cold-chain sensors submit one batch per window (Merkle root + summary),
 *    and a temperature excursion quarantines the lot.
 *  - All IDs come from the caller or the transaction ID, and all times from
 *    the transaction timestamp, so every endorsing peer computes the same result.
 *  - Fabric does not return a transaction's own writes to getState, so every
 *    method reads first and writes last.
 */
class TraceContract extends Contract {

    constructor() {
        super('trace');
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    _now(ctx) {
        const ts = ctx.stub.getTxTimestamp();
        const seconds = typeof ts.seconds === 'object' && ts.seconds !== null ? ts.seconds.toNumber() : Number(ts.seconds);
        return seconds * 1000 + Math.floor((ts.nanos || 0) / 1e6);
    }

    _iso(ms) {
        return new Date(ms).toISOString();
    }

    _json(text, what) {
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error(`${what} must be valid JSON.`);
        }
    }

    _caller(ctx) {
        const cid = ctx.clientIdentity;
        const role = cid.getAttributeValue('tr.role');
        const id = cid.getAttributeValue('tr.id');
        if (!role || !id) {
            throw new Error('Caller certificate has no tr.role / tr.id attributes; enroll the user with these attributes.');
        }
        return { id, role, mspId: cid.getMSPID() };
    }

    async _get(ctx, key) {
        const bytes = await ctx.stub.getState(key);
        return bytes && bytes.length ? JSON.parse(bytes.toString()) : null;
    }

    async _put(ctx, key, value) {
        await ctx.stub.putState(key, Buffer.from(JSON.stringify(value)));
    }

    async _list(ctx, objectType, attributes) {
        const results = [];
        const iterator = await ctx.stub.getStateByPartialCompositeKey(objectType, attributes);
        try {
            for (let res = await iterator.next(); !res.done; res = await iterator.next()) {
                results.push(JSON.parse(res.value.value.toString()));
            }
        } finally {
            await iterator.close();
        }
        return results;
    }

    _key(ctx, type, ...parts) {
        return ctx.stub.createCompositeKey(type, parts);
    }

    /**
     * Load the caller's participant record and check it matches their
     * certificate: same role and same organisation (MSP) that registered it.
     */
    async _requireCaller(ctx, ...roles) {
        const caller = this._caller(ctx);
        if (roles.length && !roles.includes(caller.role)) {
            throw new Error(`Only ${roles.join('/')} may perform this action (caller is ${caller.role}).`);
        }
        if (caller.role === ROLE.SENSOR) {
            const sensor = await this._get(ctx, this._key(ctx, 'sensor', caller.id));
            if (!sensor || !sensor.active) {
                throw new Error(`Sensor ${caller.id} is not registered.`);
            }
            if (sensor.mspId !== caller.mspId) {
                throw new Error(`Sensor ${caller.id} belongs to ${sensor.mspId}, not ${caller.mspId}.`);
            }
            return Object.assign({}, caller, { sensor });
        }
        const participant = await this._get(ctx, this._key(ctx, 'participant', caller.id));
        if (!participant) {
            throw new Error(`Participant ${caller.id} is not registered; call registerParticipant first.`);
        }
        if (participant.role !== caller.role || participant.mspId !== caller.mspId) {
            throw new Error(`Certificate for ${caller.id} does not match the registered participant.`);
        }
        return Object.assign({}, caller, { participant });
    }

    async _participant(ctx, id) {
        const p = await this._get(ctx, this._key(ctx, 'participant', id));
        if (!p) {
            throw new Error(`Participant ${id} does not exist.`);
        }
        return p;
    }

    async _lot(ctx, lotId) {
        const lot = await this._get(ctx, this._key(ctx, 'lot', lotId));
        if (!lot) {
            throw new Error(`Lot ${lotId} does not exist.`);
        }
        return lot;
    }

    async _requireNewLot(ctx, lotId) {
        if (!ID_PATTERN.test(String(lotId))) {
            throw new Error(`Invalid lot id ${lotId}.`);
        }
        if (await this._get(ctx, this._key(ctx, 'lot', lotId))) {
            throw new Error(`Lot ${lotId} already exists.`);
        }
    }

    /** The caller must hold the lot, and it must be fit to process. */
    _requireProcessable(caller, lot) {
        if (lot.custodianId !== caller.id) {
            throw new Error(`Lot ${lot.lotId} is held by ${lot.custodianId}, not ${caller.id}.`);
        }
        if (lot.status !== STATUS.OK) {
            throw new Error(`Lot ${lot.lotId} is ${lot.status} and cannot be processed.`);
        }
        if (lot.consumed) {
            throw new Error(`Lot ${lot.lotId} has already been processed.`);
        }
    }

    _positive(value, what) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
            throw new Error(`${what} must be a positive number.`);
        }
        return n;
    }

    _event(ctx, lot, type, actor, details) {
        const entry = {
            docType: 'event',
            lotId: lot.lotId,
            type,
            actorId: actor.id,
            actorRole: actor.role,
            at: this._iso(this._now(ctx)),
            txId: ctx.stub.getTxID(),
            details: details || {},
        };
        return this._put(ctx, this._key(ctx, 'event', lot.lotId, entry.txId), entry);
    }

    /** Every lot below `rootId`, including itself (reads only). */
    async _descendants(ctx, rootId) {
        const seen = new Set();
        const queue = [rootId];
        const out = [];
        while (queue.length) {
            const id = queue.shift();
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);
            const lot = await this._lot(ctx, id);
            out.push(lot);
            queue.push(...lot.childIds);
        }
        return out;
    }

    /** Every lot above `lotId`, including itself (reads only). */
    async _ancestors(ctx, lotId) {
        const seen = new Set();
        const queue = [lotId];
        const out = [];
        while (queue.length) {
            const id = queue.shift();
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);
            const lot = await this._lot(ctx, id);
            out.push(lot);
            queue.push(...lot.parentIds);
        }
        return out;
    }

    async _activeCredential(ctx, subjectId, type, atMs) {
        const creds = await this._list(ctx, 'credBySubject', [subjectId]);
        for (const ref of creds) {
            const cred = await this._get(ctx, this._key(ctx, 'credential', ref.credId));
            if (cred && cred.type === type && cred.status === 'active'
                && Date.parse(cred.issuedAt) <= atMs && Date.parse(cred.expiresAt) > atMs) {
                return cred;
            }
        }
        return null;
    }

    _childLot(parentLots, fields) {
        const first = parentLots[0];
        return Object.assign({
            docType: 'lot',
            species: first.species,
            parentIds: parentLots.map(p => p.lotId),
            childIds: [],
            originFarmIds: [...new Set(parentLots.flatMap(p => p.originFarmIds))].sort(),
            status: STATUS.OK,
            statusReason: '',
            consumed: false,
        }, fields);
    }

    // ------------------------------------------------------------------
    // Participants, credentials and sensors
    // ------------------------------------------------------------------

    /**
     * Register the caller. Role and ID come from the certificate the
     * organisation's CA issued, so nobody can register as someone else.
     * @param {string} name business name shown in provenance views
     * @param {string} nzbn 13-digit New Zealand Business Number
     */
    async registerParticipant(ctx, name, nzbn) {
        const caller = this._caller(ctx);
        if (!SELF_REGISTER_ROLES.includes(caller.role)) {
            throw new Error(`Role ${caller.role} cannot self-register.`);
        }
        if (!ID_PATTERN.test(caller.id)) {
            throw new Error(`Invalid participant id ${caller.id}.`);
        }
        if (!NZBN_PATTERN.test(String(nzbn))) {
            throw new Error('nzbn must be a 13-digit New Zealand Business Number.');
        }
        const key = this._key(ctx, 'participant', caller.id);
        if (await this._get(ctx, key)) {
            throw new Error(`Participant ${caller.id} is already registered.`);
        }
        const participant = {
            docType: 'participant',
            id: caller.id,
            role: caller.role,
            mspId: caller.mspId,
            name: String(name || caller.id).slice(0, 100),
            nzbn: String(nzbn),
            registeredAt: this._iso(this._now(ctx)),
        };
        await this._put(ctx, key, participant);
        return participant;
    }

    /**
     * A certifier issues a credential to a processor, e.g. halal approval for
     * a plant. Stored as a signed ledger entry that can expire or be revoked.
     */
    async issueCredential(ctx, subjectId, type, claimsJson, expiresAt) {
        const caller = await this._requireCaller(ctx, ROLE.CERTIFIER);
        const subject = await this._participant(ctx, subjectId);
        if (!CREDENTIAL_TYPES.includes(type)) {
            throw new Error(`Credential type must be one of ${CREDENTIAL_TYPES.join(', ')}.`);
        }
        if (subject.role !== ROLE.PROCESSOR) {
            throw new Error('Credentials are issued to processors.');
        }
        const now = this._now(ctx);
        const expiry = Date.parse(expiresAt);
        if (Number.isNaN(expiry) || expiry <= now) {
            throw new Error('expiresAt must be a valid future ISO-8601 date.');
        }
        const claims = this._json(claimsJson || '{}', 'claims');
        const credId = ctx.stub.getTxID();
        const cred = {
            docType: 'credential',
            credId,
            type,
            subjectId,
            issuerId: caller.id,
            issuerName: caller.participant.name,
            claims,
            status: 'active',
            issuedAt: this._iso(now),
            expiresAt: this._iso(expiry),
        };
        await this._put(ctx, this._key(ctx, 'credential', credId), cred);
        await this._put(ctx, this._key(ctx, 'credBySubject', subjectId, credId), { subjectId, credId });
        ctx.stub.setEvent('CredentialIssued', Buffer.from(JSON.stringify({ credId, type, subjectId })));
        return cred;
    }

    /** Only the issuer can revoke. Products slaughtered under it lose the claim. */
    async revokeCredential(ctx, credId, reason) {
        const caller = await this._requireCaller(ctx, ROLE.CERTIFIER);
        const key = this._key(ctx, 'credential', credId);
        const cred = await this._get(ctx, key);
        if (!cred) {
            throw new Error(`Credential ${credId} does not exist.`);
        }
        if (cred.issuerId !== caller.id) {
            throw new Error('Only the issuing certifier can revoke a credential.');
        }
        if (cred.status !== 'active') {
            throw new Error(`Credential ${credId} is already ${cred.status}.`);
        }
        cred.status = 'revoked';
        cred.revokedAt = this._iso(this._now(ctx));
        cred.revocationReason = String(reason || '').slice(0, 300);
        await this._put(ctx, key, cred);
        ctx.stub.setEvent('CredentialRevoked', Buffer.from(JSON.stringify({ credId, subjectId: cred.subjectId })));
        return cred;
    }

    /** A processor, logistics firm or store registers a cold-chain sensor it owns. */
    async registerSensor(ctx, sensorId) {
        const caller = await this._requireCaller(ctx, ...SENSOR_OWNER_ROLES);
        if (!ID_PATTERN.test(String(sensorId))) {
            throw new Error(`Invalid sensor id ${sensorId}.`);
        }
        const key = this._key(ctx, 'sensor', sensorId);
        if (await this._get(ctx, key)) {
            throw new Error(`Sensor ${sensorId} is already registered.`);
        }
        const sensor = {
            docType: 'sensor',
            id: sensorId,
            ownerId: caller.id,
            mspId: caller.mspId,
            active: true,
            registeredAt: this._iso(this._now(ctx)),
        };
        await this._put(ctx, key, sensor);
        return sensor;
    }

    // ------------------------------------------------------------------
    // Lots: animals, slaughter, cutting, mixing, custody
    // ------------------------------------------------------------------

    /**
     * A farm registers animals leaving for slaughter.
     * Beef: the NAIT numbers of the animals. Lamb: the Animal Status
     * Declaration (ASD) reference and the head count (sheep are not in NAIT).
     * @param {string} idsJson beef: {"naitIds": [...]}, lamb: {"asdRef": "...", "headCount": n}
     */
    async registerAnimalLot(ctx, lotId, species, idsJson, liveWeightKg) {
        const caller = await this._requireCaller(ctx, ROLE.FARM);
        await this._requireNewLot(ctx, lotId);
        const ids = this._json(idsJson, 'ids');
        let identifiers;
        if (species === SPECIES.BEEF) {
            if (!Array.isArray(ids.naitIds) || !ids.naitIds.length || ids.naitIds.some(x => !String(x).trim())) {
                throw new Error('Beef lots need a non-empty list of NAIT animal numbers (naitIds).');
            }
            identifiers = { naitIds: [...new Set(ids.naitIds.map(String))].sort(), headCount: new Set(ids.naitIds).size };
        } else if (species === SPECIES.LAMB) {
            if (!ids.asdRef || !Number.isInteger(ids.headCount) || ids.headCount < 1) {
                throw new Error('Lamb lots need an ASD reference (asdRef) and a positive integer headCount.');
            }
            identifiers = { asdRef: String(ids.asdRef), headCount: ids.headCount };
        } else {
            throw new Error(`species must be ${SPECIES.BEEF} or ${SPECIES.LAMB}.`);
        }
        const lot = {
            docType: 'lot',
            lotId,
            kind: KIND.ANIMAL,
            species,
            identifiers,
            weightKg: this._positive(liveWeightKg, 'liveWeightKg'),
            parentIds: [],
            childIds: [],
            originFarmIds: [caller.id],
            custodianId: caller.id,
            halal: [],
            status: STATUS.OK,
            statusReason: '',
            consumed: false,
            createdAt: this._iso(this._now(ctx)),
        };
        await this._put(ctx, this._key(ctx, 'lot', lotId), lot);
        await this._event(ctx, lot, 'register-animals', caller, identifiers);
        return lot;
    }

    /** Hand a lot to the next business in the chain (ship / receive in one step). */
    async transferLot(ctx, lotId, toId, location) {
        const caller = await this._requireCaller(ctx, ...CUSTODIAN_ROLES);
        const lot = await this._lot(ctx, lotId);
        if (lot.custodianId !== caller.id) {
            throw new Error(`Lot ${lotId} is held by ${lot.custodianId}, not ${caller.id}.`);
        }
        if (lot.status === STATUS.RECALLED) {
            throw new Error(`Lot ${lotId} is recalled and cannot be moved on.`);
        }
        const to = await this._participant(ctx, toId);
        if (!CUSTODIAN_ROLES.includes(to.role)) {
            throw new Error(`${toId} (${to.role}) cannot take custody of goods.`);
        }
        lot.custodianId = toId;
        await this._put(ctx, this._key(ctx, 'lot', lotId), lot);
        await this._event(ctx, lot, 'transfer', caller, { from: caller.id, to: toId, location: String(location || '') });
        return lot;
    }

    /**
     * A processor slaughters a lot of animals into carcass lots.
     * @param {string} carcassesJson [{"lotId": "...", "weightKg": n}, ...]
     * @param {string} halal "true" to claim halal slaughter (needs an active halal credential)
     */
    async slaughterLot(ctx, lotId, carcassesJson, halal) {
        const caller = await this._requireCaller(ctx, ROLE.PROCESSOR);
        const parent = await this._lot(ctx, lotId);
        if (parent.kind !== KIND.ANIMAL) {
            throw new Error(`Lot ${lotId} is not a lot of live animals.`);
        }
        this._requireProcessable(caller, parent);
        const carcasses = this._json(carcassesJson, 'carcasses');
        if (!Array.isArray(carcasses) || !carcasses.length) {
            throw new Error('At least one carcass is required.');
        }
        let halalClaim = [];
        if (String(halal) === 'true') {
            const cred = await this._activeCredential(ctx, caller.id, 'halal', this._now(ctx));
            if (!cred) {
                throw new Error(`${caller.id} has no active halal credential, so it cannot claim halal slaughter.`);
            }
            halalClaim = [{ credId: cred.credId, issuerId: cred.issuerId, slaughteredAt: this._iso(this._now(ctx)) }];
        }
        const now = this._iso(this._now(ctx));
        const children = [];
        let total = 0;
        for (const c of carcasses) {
            await this._requireNewLot(ctx, c.lotId);
            total += this._positive(c.weightKg, 'carcass weightKg');
            children.push(this._childLot([parent], {
                lotId: c.lotId,
                kind: KIND.CARCASS,
                weightKg: Number(c.weightKg),
                custodianId: caller.id,
                halal: halalClaim,
                processorId: caller.id,
                createdAt: now,
            }));
        }
        if (new Set(children.map(c => c.lotId)).size !== children.length) {
            throw new Error('Carcass lot ids must be unique.');
        }
        if (total > parent.weightKg) {
            throw new Error(`Carcasses (${total} kg) cannot weigh more than the live animals (${parent.weightKg} kg).`);
        }
        parent.consumed = true;
        parent.childIds = children.map(c => c.lotId);
        await this._put(ctx, this._key(ctx, 'lot', lotId), parent);
        await this._event(ctx, parent, 'slaughter', caller, { carcasses: parent.childIds, halal: halalClaim.length > 0 });
        for (const child of children) {
            await this._put(ctx, this._key(ctx, 'lot', child.lotId), child);
            await this._event(ctx, child, 'create-carcass', caller, { from: lotId });
        }
        return children;
    }

    /**
     * Cut one carcass (or product) into retail products.
     * @param {string} productsJson [{"lotId", "gtin", "product", "weightKg", "useBy", "maxTempC"?}, ...]
     */
    async splitLot(ctx, lotId, productsJson) {
        const caller = await this._requireCaller(ctx, ROLE.PROCESSOR);
        const parent = await this._lot(ctx, lotId);
        if (parent.kind === KIND.ANIMAL) {
            throw new Error('Live animals must be slaughtered before they can be cut.');
        }
        this._requireProcessable(caller, parent);
        const children = await this._products(ctx, caller, [parent], this._json(productsJson, 'products'));
        const total = children.reduce((s, c) => s + c.weightKg, 0);
        if (total > parent.weightKg) {
            throw new Error(`Products (${total} kg) cannot weigh more than lot ${lotId} (${parent.weightKg} kg).`);
        }
        parent.consumed = true;
        parent.childIds = children.map(c => c.lotId);
        await this._put(ctx, this._key(ctx, 'lot', lotId), parent);
        await this._event(ctx, parent, 'split', caller, { products: parent.childIds });
        for (const child of children) {
            await this._put(ctx, this._key(ctx, 'lot', child.lotId), child);
            await this._event(ctx, child, 'create-product', caller, { from: [lotId], halal: child.halal.length > 0 });
        }
        return children;
    }

    /**
     * Combine several lots of the same species into one product, e.g. trim
     * from many carcasses into mince. The product is halal only if every input is.
     * @param {string} parentIdsJson ["lotA", "lotB", ...]
     * @param {string} productJson {"lotId", "gtin", "product", "weightKg", "useBy", "maxTempC"?}
     */
    async mergeLots(ctx, parentIdsJson, productJson) {
        const caller = await this._requireCaller(ctx, ROLE.PROCESSOR);
        const parentIds = this._json(parentIdsJson, 'parentIds');
        if (!Array.isArray(parentIds) || parentIds.length < 2 || new Set(parentIds).size !== parentIds.length) {
            throw new Error('Merging needs at least two different input lots.');
        }
        const parents = [];
        for (const id of parentIds) {
            const p = await this._lot(ctx, id);
            if (p.kind === KIND.ANIMAL) {
                throw new Error('Live animals must be slaughtered before they can be processed.');
            }
            this._requireProcessable(caller, p);
            parents.push(p);
        }
        if (new Set(parents.map(p => p.species)).size !== 1) {
            throw new Error('Lots of different species cannot be merged into one product.');
        }
        const [child] = await this._products(ctx, caller, parents, [this._json(productJson, 'product')]);
        const inputKg = parents.reduce((s, p) => s + p.weightKg, 0);
        if (child.weightKg > inputKg) {
            throw new Error(`The product (${child.weightKg} kg) cannot weigh more than its inputs (${inputKg} kg).`);
        }
        const droppedHalal = parents.some(p => p.halal.length > 0) && child.halal.length === 0;
        for (const p of parents) {
            p.consumed = true;
            p.childIds = [child.lotId];
            await this._put(ctx, this._key(ctx, 'lot', p.lotId), p);
            await this._event(ctx, p, 'merge', caller, { into: child.lotId });
        }
        await this._put(ctx, this._key(ctx, 'lot', child.lotId), child);
        await this._event(ctx, child, 'create-product', caller, {
            from: parentIds, halal: child.halal.length > 0, halalDroppedByMixing: droppedHalal,
        });
        return child;
    }

    /** Build validated product lots from `parents` (shared by split and merge). */
    async _products(ctx, caller, parents, specs) {
        if (!Array.isArray(specs) || !specs.length) {
            throw new Error('At least one product is required.');
        }
        const allHalal = parents.every(p => p.halal.length > 0);
        const halal = allHalal ? parents.flatMap(p => p.halal)
            .filter((h, i, arr) => arr.findIndex(x => x.credId === h.credId) === i) : [];
        const now = this._now(ctx);
        const products = [];
        for (const s of specs) {
            await this._requireNewLot(ctx, s.lotId);
            if (!GTIN_PATTERN.test(String(s.gtin))) {
                throw new Error(`Product ${s.lotId} needs a valid GTIN (8, 12, 13 or 14 digits).`);
            }
            const useBy = Date.parse(s.useBy);
            if (Number.isNaN(useBy) || useBy <= now) {
                throw new Error(`Product ${s.lotId} needs a future useBy date.`);
            }
            if (s.maxTempC !== undefined && !Number.isFinite(Number(s.maxTempC))) {
                throw new Error(`Product ${s.lotId} has an invalid maxTempC.`);
            }
            products.push(this._childLot(parents, {
                lotId: s.lotId,
                kind: KIND.PRODUCT,
                gtin: String(s.gtin),
                product: String(s.product || '').slice(0, 100),
                weightKg: this._positive(s.weightKg, `product ${s.lotId} weightKg`),
                useBy: this._iso(useBy),
                maxTempC: s.maxTempC === undefined ? DEFAULT_MAX_TEMP_C : Number(s.maxTempC),
                maxExcursionMinutes: DEFAULT_MAX_EXCURSION_MINUTES,
                custodianId: caller.id,
                halal,
                processorId: caller.id,
                createdAt: this._iso(now),
            }));
        }
        if (new Set(products.map(p => p.lotId)).size !== products.length) {
            throw new Error('Product lot ids must be unique.');
        }
        return products;
    }

    // ------------------------------------------------------------------
    // Cold chain
    // ------------------------------------------------------------------

    /**
     * A sensor submits one window of readings for a lot its owner holds.
     * Raw readings stay off-chain; the Merkle root lets anyone later prove a
     * single reading belonged to this batch. An excursion quarantines the lot.
     * @param {string} batchJson {windowStart, windowEnd, count, merkleRoot, minC, maxC, minutesAbove}
     */
    async submitColdChainBatch(ctx, lotId, batchJson) {
        const caller = await this._requireCaller(ctx, ROLE.SENSOR);
        const lot = await this._lot(ctx, lotId);
        if (lot.kind !== KIND.PRODUCT) {
            throw new Error('Cold-chain readings are recorded for product lots.');
        }
        if (lot.custodianId !== caller.sensor.ownerId) {
            throw new Error(`Sensor ${caller.id} belongs to ${caller.sensor.ownerId}, which does not hold lot ${lotId}.`);
        }
        const b = this._json(batchJson, 'batch');
        const start = Date.parse(b.windowStart);
        const end = Date.parse(b.windowEnd);
        if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
            throw new Error('windowStart/windowEnd must be ISO-8601 dates with start <= end.');
        }
        if (!Number.isInteger(b.count) || b.count < 1) {
            throw new Error('count must be a positive integer.');
        }
        if (!SHA256_HEX.test(b.merkleRoot)) {
            throw new Error('merkleRoot must be a hex SHA-256 digest.');
        }
        for (const k of ['minC', 'maxC', 'minutesAbove']) {
            if (typeof b[k] !== 'number' || !Number.isFinite(b[k])) {
                throw new Error(`${k} must be a number.`);
            }
        }
        const excursion = b.maxC > lot.maxTempC && b.minutesAbove > lot.maxExcursionMinutes;
        const txId = ctx.stub.getTxID();
        const entry = {
            docType: 'coldChain',
            lotId,
            sensorId: caller.id,
            ownerId: caller.sensor.ownerId,
            windowStart: this._iso(start),
            windowEnd: this._iso(end),
            count: b.count,
            merkleRoot: b.merkleRoot,
            minC: b.minC,
            maxC: b.maxC,
            minutesAbove: b.minutesAbove,
            limitC: lot.maxTempC,
            excursion,
            txId,
        };
        await this._put(ctx, this._key(ctx, 'coldChain', lotId, txId), entry);
        if (excursion && lot.status === STATUS.OK) {
            lot.status = STATUS.QUARANTINED;
            lot.statusReason = `Above ${lot.maxTempC} °C for ${b.minutesAbove} min (sensor ${caller.id})`;
            await this._put(ctx, this._key(ctx, 'lot', lotId), lot);
            await this._event(ctx, lot, 'quarantine', caller, { reason: lot.statusReason });
            ctx.stub.setEvent('LotQuarantined', Buffer.from(JSON.stringify({ lotId, reason: lot.statusReason })));
        }
        return entry;
    }

    /** The regulator releases a quarantined lot after inspection. */
    async releaseQuarantine(ctx, lotId, reason) {
        const caller = await this._requireCaller(ctx, ROLE.REGULATOR);
        const lot = await this._lot(ctx, lotId);
        if (lot.status !== STATUS.QUARANTINED) {
            throw new Error(`Lot ${lotId} is not quarantined.`);
        }
        if (!reason || String(reason).trim().length < 10) {
            throw new Error('A reason of at least 10 characters is required to release a lot.');
        }
        lot.status = STATUS.OK;
        lot.statusReason = '';
        await this._put(ctx, this._key(ctx, 'lot', lotId), lot);
        await this._event(ctx, lot, 'release', caller, { reason: String(reason).slice(0, 300) });
        return lot;
    }

    // ------------------------------------------------------------------
    // Recall, point of sale and provenance
    // ------------------------------------------------------------------

    /**
     * Recall a lot and everything made from it, wherever it is now.
     * @returns {{recalled: number, lots: Array<{lotId, kind, product, custodianId}>}}
     */
    async recall(ctx, lotId, reason) {
        const caller = await this._requireCaller(ctx, ...RECALL_ROLES);
        if (!reason || String(reason).trim().length < 10) {
            throw new Error('A reason of at least 10 characters is required for a recall.');
        }
        const root = await this._lot(ctx, lotId);
        if (caller.role !== ROLE.REGULATOR && root.processorId !== caller.id && root.custodianId !== caller.id) {
            throw new Error(`${caller.id} neither processed nor holds lot ${lotId}; only the regulator can recall it.`);
        }
        const affected = await this._descendants(ctx, lotId);
        const why = `Recall: ${String(reason).slice(0, 300)}`;
        for (const lot of affected) {
            lot.status = STATUS.RECALLED;
            lot.statusReason = why;
            await this._put(ctx, this._key(ctx, 'lot', lot.lotId), lot);
            await this._event(ctx, lot, 'recall', caller, { root: lotId, reason: why });
        }
        const lots = affected.map(l => ({ lotId: l.lotId, kind: l.kind, product: l.product || '', custodianId: l.custodianId }));
        ctx.stub.setEvent('Recall', Buffer.from(JSON.stringify({ root: lotId, lots: lots.map(l => l.lotId) })));
        return { recalled: lots.length, lots };
    }

    /**
     * What a checkout or shelf scan asks: can this pack be sold, and is its
     * halal claim still good? Evaluate-only (no write).
     */
    async checkSaleable(ctx, lotId) {
        await this._requireCaller(ctx);
        const lot = await this._lot(ctx, lotId);
        const reasons = [];
        if (lot.kind !== KIND.PRODUCT) {
            reasons.push('not a retail product');
        }
        if (lot.status !== STATUS.OK) {
            reasons.push(lot.statusReason || lot.status);
        }
        if (lot.useBy && Date.parse(lot.useBy) <= this._now(ctx)) {
            reasons.push('past its use-by date');
        }
        // A certificate that simply expired after slaughter still covers the
        // product; a revoked one does not (revocation means the certifier no
        // longer stands behind that plant's slaughter).
        let halalValid = false;
        if (lot.halal.length) {
            halalValid = true;
            for (const h of lot.halal) {
                const cred = await this._get(ctx, this._key(ctx, 'credential', h.credId));
                if (!cred || cred.status === 'revoked') {
                    halalValid = false;
                }
            }
            if (!halalValid) {
                reasons.push('halal certificate behind this product has been revoked');
            }
        }
        return { lotId, saleable: reasons.length === 0, halalClaim: lot.halal.length > 0, halalValid, reasons };
    }

    /**
     * The shopper's QR view: where the product came from, who certified it
     * and how it was kept. Business names only, no personal data.
     */
    async getProvenance(ctx, lotId) {
        await this._requireCaller(ctx);
        const lots = await this._ancestors(ctx, lotId);
        const lot = lots[0];
        const names = {};
        const name = async id => {
            if (!(id in names)) {
                const p = await this._get(ctx, this._key(ctx, 'participant', id));
                names[id] = p ? p.name : id;
            }
            return names[id];
        };
        const farms = [];
        for (const l of lots.filter(x => x.kind === KIND.ANIMAL)) {
            farms.push({ farm: await name(l.originFarmIds[0]), species: l.species, headCount: l.identifiers.headCount,
                tracing: l.identifiers.naitIds ? 'NAIT' : 'ASD' });
        }
        const processors = [];
        for (const id of [...new Set(lots.filter(x => x.processorId).map(x => x.processorId))]) {
            processors.push(await name(id));
        }
        const halal = [];
        for (const h of lot.halal) {
            const cred = await this._get(ctx, this._key(ctx, 'credential', h.credId));
            halal.push({ certifier: cred ? cred.issuerName : h.issuerId, status: cred ? cred.status : 'unknown' });
        }
        const batches = await this._list(ctx, 'coldChain', [lotId]);
        return {
            lotId,
            product: lot.product || '',
            species: lot.species,
            status: lot.status,
            useBy: lot.useBy || null,
            farms,
            processors,
            halal,
            coldChain: { batches: batches.length, excursions: batches.filter(b => b.excursion).length,
                maxC: batches.length ? Math.max(...batches.map(b => b.maxC)) : null },
        };
    }

    async getLot(ctx, lotId) {
        await this._requireCaller(ctx);
        return this._lot(ctx, lotId);
    }

    /** Events for a lot in time order. */
    async getLotEvents(ctx, lotId) {
        await this._requireCaller(ctx);
        const events = await this._list(ctx, 'event', [lotId]);
        return events.sort((a, b) => a.at.localeCompare(b.at) || a.txId.localeCompare(b.txId));
    }
}

module.exports = TraceContract;
