'use strict';

/**
 * Encrypted off-chain storage for medical records and raw wearable readings.
 *
 * Envelope encryption:
 *   - each patient has a random 256-bit data key (DEK);
 *   - the DEK is stored wrapped (AES-256-GCM) under a master key (KEK);
 *   - documents are encrypted with AES-256-GCM under the patient's DEK.
 * Only the SHA-256 of the encrypted blob and its storage URI go on the ledger,
 * so the ledger proves integrity without holding any health data.
 *
 * Deleting a patient's DEK ("crypto-shredding") makes every copy of their
 * off-chain records unreadable, which complements purging private data.
 *
 * The master key comes from HC_MASTER_KEY (base64, 32 bytes). For local
 * development a key is generated in data/master.key; in production use a
 * KMS/HSM and never keep the key next to the data.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALG = 'aes-256-gcm';
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function seal(key, plaintext, aad) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALG, key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    // layout: version(1) | iv(12) | tag(16) | ciphertext
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
}

function open(key, blob, aad) {
    if (blob[0] !== 1) {
        throw new Error('Unknown blob version');
    }
    const iv = blob.subarray(1, 13);
    const tag = blob.subarray(13, 29);
    const decipher = crypto.createDecipheriv(ALG, key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
}

class Vault {
    constructor(dataDir, masterKeyB64) {
        this.dir = dataDir;
        this.blobDir = path.join(dataDir, 'offchain');
        this.keyDir = path.join(dataDir, 'keys');
        fs.mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
        fs.mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
        this.kek = this._loadMasterKey(masterKeyB64);
    }

    _loadMasterKey(b64) {
        if (b64) {
            const key = Buffer.from(b64, 'base64');
            if (key.length !== 32) {
                throw new Error('HC_MASTER_KEY must be 32 bytes, base64 encoded');
            }
            return key;
        }
        const file = path.join(this.dir, 'master.key');
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
            console.warn(`[vault] HC_MASTER_KEY not set; generated a development key in ${file}`);
        }
        return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    }

    _dekPath(patientId) {
        if (!SAFE_ID.test(patientId)) {
            throw new Error('Invalid patient id');
        }
        return path.join(this.keyDir, `${patientId}.key`);
    }

    _dek(patientId, create) {
        const file = this._dekPath(patientId);
        if (fs.existsSync(file)) {
            return open(this.kek, fs.readFileSync(file), `dek:${patientId}`);
        }
        if (!create) {
            throw Object.assign(new Error(`No data key for ${patientId} (erased or never created)`), { status: 410 });
        }
        const dek = crypto.randomBytes(32);
        fs.writeFileSync(file, seal(this.kek, dek, `dek:${patientId}`), { mode: 0o600 });
        return dek;
    }

    /**
     * Encrypt a JSON document for a patient and store it.
     * @returns {{storageUri: string, contentHash: string}}
     */
    put(patientId, kind, doc) {
        const id = crypto.randomUUID();
        const storageUri = `offchain://${kind}/${id}`;
        const blob = seal(this._dek(patientId, true), Buffer.from(JSON.stringify(doc)), `${patientId}|${storageUri}`);
        fs.writeFileSync(this._blobPath(storageUri), blob, { mode: 0o600 });
        return { storageUri, contentHash: sha256(blob) };
    }

    /**
     * Load, verify against the on-chain hash, and decrypt.
     */
    get(patientId, storageUri, expectedHash) {
        const blob = fs.readFileSync(this._blobPath(storageUri));
        const actual = sha256(blob);
        if (actual !== expectedHash) {
            throw Object.assign(new Error(`Integrity check failed for ${storageUri}: stored blob does not match the on-chain hash`), { status: 409 });
        }
        return JSON.parse(open(this._dek(patientId, false), blob, `${patientId}|${storageUri}`).toString());
    }

    /** Crypto-shred: drop the patient's data key so every blob becomes unreadable. */
    shred(patientId) {
        const file = this._dekPath(patientId);
        if (fs.existsSync(file)) {
            fs.rmSync(file);
            return true;
        }
        return false;
    }

    _blobPath(storageUri) {
        const m = /^offchain:\/\/([a-z-]+)\/([0-9a-f-]{36})$/.exec(storageUri);
        if (!m) {
            throw new Error(`Invalid storage URI ${storageUri}`);
        }
        return path.join(this.blobDir, `${m[1]}-${m[2]}.bin`);
    }
}

module.exports = { Vault, sha256 };
