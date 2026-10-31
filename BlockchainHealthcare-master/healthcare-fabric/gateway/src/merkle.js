'use strict';

/**
 * Merkle tree over wearable readings. Only the root goes on the ledger; any
 * single reading can later be proven part of the batch with a short proof.
 * Leaves are SHA-256 of the reading's canonical JSON, prefixed with 0x00;
 * inner nodes are SHA-256(0x01 | left | right) (domain separation prevents
 * second-preimage tricks). An odd node is promoted unchanged.
 */

const crypto = require('crypto');

const h = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest();

function canonical(reading) {
    return JSON.stringify(Object.keys(reading).sort().reduce((o, k) => {
        o[k] = reading[k];
        return o;
    }, {}));
}

function leaf(reading) {
    return h(Buffer.from([0]), Buffer.from(canonical(reading)));
}

function levels(readings) {
    if (!readings.length) {
        throw new Error('Cannot build a Merkle tree with no readings');
    }
    const out = [readings.map(leaf)];
    while (out[out.length - 1].length > 1) {
        const prev = out[out.length - 1];
        const next = [];
        for (let i = 0; i < prev.length; i += 2) {
            next.push(i + 1 < prev.length ? h(Buffer.from([1]), prev[i], prev[i + 1]) : prev[i]);
        }
        out.push(next);
    }
    return out;
}

function merkleRoot(readings) {
    const l = levels(readings);
    return l[l.length - 1][0].toString('hex');
}

/** Sibling path for reading `index`: [{hash, left}] from leaf to root. */
function merkleProof(readings, index) {
    const proof = [];
    let i = index;
    for (const level of levels(readings).slice(0, -1)) {
        const sibling = i % 2 === 0 ? i + 1 : i - 1;
        if (sibling < level.length) {
            proof.push({ hash: level[sibling].toString('hex'), left: sibling < i });
        }
        i = Math.floor(i / 2);
    }
    return proof;
}

function verifyProof(reading, proof, root) {
    let node = leaf(reading);
    for (const step of proof) {
        const sib = Buffer.from(step.hash, 'hex');
        node = step.left ? h(Buffer.from([1]), sib, node) : h(Buffer.from([1]), node, sib);
    }
    return node.toString('hex') === root;
}

module.exports = { merkleRoot, merkleProof, verifyProof, canonical };
