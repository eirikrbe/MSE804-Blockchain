'use strict';

/**
 * Minimal in-memory stand-in for the Fabric chaincode stub and client
 * identity, enough to unit-test the contract without a network.
 *
 * Like Fabric, writes are buffered during a transaction: getState never
 * returns the transaction's own writes, and nothing reaches the ledger
 * unless the transaction succeeds (call `commit()` after it returns).
 * Composite keys use the same encoding as fabric-shim (\u0000 separators).
 */

const crypto = require('crypto');

const SEP = '\u0000';

class Ledger {
    constructor(startIso) {
        this.state = new Map();
        this.time = Date.parse(startIso || '2026-11-02T08:00:00Z');
        this.txCounter = 0;
        this.events = [];
    }

    advance(ms) {
        this.time += ms;
    }
}

class MockStub {
    constructor(ledger) {
        this.ledger = ledger;
        this.txId = crypto.createHash('sha256').update(String(++ledger.txCounter)).digest('hex');
        this.writes = new Map();
        this.events = [];
    }

    getTxID() {
        return this.txId;
    }

    getTxTimestamp() {
        return { seconds: Math.floor(this.ledger.time / 1000), nanos: (this.ledger.time % 1000) * 1e6 };
    }

    createCompositeKey(objectType, attributes) {
        return SEP + objectType + SEP + attributes.map(a => a + SEP).join('');
    }

    async getState(key) {
        return this.ledger.state.get(key) || Buffer.alloc(0);
    }

    async putState(key, value) {
        this.writes.set(key, Buffer.from(value));
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

    setEvent(name, payload) {
        this.events.push({ name, payload: JSON.parse(payload.toString()) });
    }

    /** Apply the buffered writes, as the peer does when a transaction commits. */
    commit() {
        for (const [k, v] of this.writes) {
            this.ledger.state.set(k, v);
        }
        this.ledger.events.push(...this.events);
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
}

/**
 * Build a transaction context for a user.
 * @param {Ledger} ledger shared world state
 * @param {{mspId: string, role: string, id: string}} user caller
 */
function contextFor(ledger, user) {
    return {
        stub: new MockStub(ledger),
        clientIdentity: new MockClientIdentity(user.mspId, { 'tr.role': user.role, 'tr.id': user.id }),
    };
}

/** Run one transaction and commit it only if it succeeds. */
async function invoke(contract, ledger, user, fn, ...args) {
    const ctx = contextFor(ledger, user);
    const result = await contract[fn](ctx, ...args);
    ctx.stub.commit();
    return result;
}

module.exports = { Ledger, contextFor, invoke };
