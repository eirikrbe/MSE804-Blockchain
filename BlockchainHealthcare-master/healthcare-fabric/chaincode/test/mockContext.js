'use strict';

/**
 * Minimal in-memory stand-in for the Fabric chaincode stub and client
 * identity, enough to unit-test the contract without a network.
 * Composite keys use the same encoding as fabric-shim (\u0000 separators).
 */

const crypto = require('crypto');

const SEP = '\u0000';

class Ledger {
    constructor() {
        this.state = new Map();
        this.history = new Map();
        this.private = new Map();
        this.purged = [];
        this.time = Date.parse('2026-10-09T10:00:00Z');
        this.txCounter = 0;
    }

    advance(ms) {
        this.time += ms;
    }
}

class MockStub {
    constructor(ledger, transient) {
        this.ledger = ledger;
        this.txId = crypto.createHash('sha256').update(String(++ledger.txCounter)).digest('hex');
        this.transient = new Map(Object.entries(transient || {}).map(([k, v]) => [k, Buffer.from(v)]));
        this.events = [];
        this.writes = new Map();
    }

    getTxID() {
        return this.txId;
    }

    getTxTimestamp() {
        return { seconds: Math.floor(this.ledger.time / 1000), nanos: (this.ledger.time % 1000) * 1e6 };
    }

    getTransient() {
        return this.transient;
    }

    createCompositeKey(objectType, attributes) {
        return SEP + objectType + SEP + attributes.map(a => a + SEP).join('');
    }

    async getState(key) {
        return this.ledger.state.get(key) || Buffer.alloc(0);
    }

    async putState(key, value) {
        this.ledger.state.set(key, Buffer.from(value));
        const h = this.ledger.history.get(key) || [];
        h.push({ txId: this.txId, isDelete: false, value: Buffer.from(value) });
        this.ledger.history.set(key, h);
    }

    async deleteState(key) {
        this.ledger.state.delete(key);
    }

    _iterator(entries) {
        let i = 0;
        return {
            next: async () => (i < entries.length ? { value: entries[i++], done: false } : { done: true }),
            close: async () => {},
        };
    }

    async getStateByPartialCompositeKey(objectType, attributes) {
        const prefix = this.createCompositeKey(objectType, attributes);
        const entries = [...this.ledger.state.entries()]
            .filter(([k]) => k.startsWith(prefix))
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, value]) => ({ key, value }));
        return this._iterator(entries);
    }

    async getHistoryForKey(key) {
        // Like Fabric: most recent modification first.
        return this._iterator((this.ledger.history.get(key) || []).slice().reverse());
    }

    async putPrivateData(collection, key, value) {
        this.ledger.private.set(collection + '/' + key, Buffer.from(value));
    }

    async getPrivateData(collection, key) {
        return this.ledger.private.get(collection + '/' + key) || Buffer.alloc(0);
    }

    async purgePrivateData(collection, key) {
        this.ledger.private.delete(collection + '/' + key);
        this.ledger.purged.push(collection + '/' + key);
    }

    setEvent(name, payload) {
        this.events.push({ name, payload: JSON.parse(payload.toString()) });
    }
}

class MockClientIdentity {
    constructor(mspId, attrs) {
        this.mspId = mspId;
        this.attrs = attrs;
    }

    getMSPID() {
        return this.mspId;
    }

    getAttributeValue(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    }

    getID() {
        return `x509::CN=${this.attrs['hc.id']}::CN=ca.${this.mspId}`;
    }
}

/**
 * Build a transaction context for a user.
 * @param {Ledger} ledger shared world state
 * @param {{mspId: string, role: string, id: string}} user caller
 * @param {Object} [transient] transient map (string values)
 */
function contextFor(ledger, user, transient) {
    return {
        stub: new MockStub(ledger, transient),
        clientIdentity: new MockClientIdentity(user.mspId, { 'hc.role': user.role, 'hc.id': user.id }),
    };
}

module.exports = { Ledger, contextFor };
