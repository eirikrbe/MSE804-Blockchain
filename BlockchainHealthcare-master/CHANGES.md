# What was changed to fix the issues

This document lists every problem found in the review of
[alexmj8/BlockchainHealthcare](https://github.com/alexmj8/BlockchainHealthcare) and explains **what was changed, where, and how the fix was verified**.

* **Original code:** `../BlockchainHealthcare-original/healthcare-network/` (kept untouched for comparison).
* **Fixed original:** [`healthcare-network/`](healthcare-network/) — the same Hyperledger Composer app, repaired.
* **Recommended redesign:** [`healthcare-fabric/`](healthcare-fabric/) — the app rebuilt on Fabric 2.5 with the improvements proposed in the presentation.

How to run each version is in the [main README](README.md).

---

## Overview

| # | Issue (from the review) | Severity | Fixed in Composer version | Fixed in Fabric 2.5 version |
|---|---|---|---|---|
| 1 | Granting access removed everyone else's access | Critical | ✅ | ✅ |
| 2 | Revoking one person removed everyone | Critical | ✅ | ✅ |
| 3 | Random record IDs (peers can disagree) | High | ✅ | ✅ |
| 4 | Trainer access stored only on the trainer side | Medium | ✅ | ✅ |
| 5 | Wrong "last consultation" on record update | Low | ✅ | ✅ |
| 6 | Doctors/labs could add patients to their own list | Critical | ✅ | ✅ |
| 7 | Patients could change any doctor's patient list | High | ✅ | ✅ |
| 8 | Smart bands could write/delete data for any patient | High | ✅ | ✅ |
| 9 | Anyone could read the full transaction history | High | ✅ | ✅ |
| 10 | Secrets committed (keys, enrollment secrets, API token) | Critical | ✅ | ✅ |
| 11 | Health records unencrypted on every peer, can't be erased | High | — (needs redesign) | ✅ |
| 12 | Tests were Composer template leftovers | Medium | ✅ | ✅ |
| 13 | Application could not be installed or run any more | Blocker | ✅ | ✅ |
| 14 | Missing features (apps, lab upload, expiry, emergency, access log, files) | — | — | ✅ |
| 15 | Old platform, one organisation, one transaction per reading | — | — | ✅ |

Issues 1–13 are fixed in the original Composer app itself. Issues 11, 14 and 15 need a different architecture, so they are solved in the Fabric 2.5 version.

---

## Part A — Fixes to the original Composer application (`healthcare-network/`)

### 1 & 2. Sharing logic overwrote the access lists

**Problem.** Every grant/revoke function started from a brand-new empty array and assigned it to the participant, throwing the existing list away.

Original `lib/logic.js:30` (grant) and `:52` (revoke); the same pattern for labs at `:83` / `:105` and in the trainer functions:

```js
// GRANT — original
var authorizedCliniciansArr = [];
invokingParticipant.authorizedClinicians = authorizedCliniciansArr;   // old list is gone
authorizedCliniciansArr.push(transaction.authorizedClinician);

// REVOKE — original
var list = [];
invokingParticipant.authorizedClinicians = list;                      // list is now empty
var index = list.map(x => x.clinicianId).indexOf(...);                // always -1
list.splice(index, 1);                                                 // splice(-1, 1) on []
```

Effect: grant Doctor A, then Doctor B → only Doctor B is left. Revoke anyone → **everyone** is removed. The doctor's side had the same bug, so a doctor's list only ever held the *last* patient who granted access.

**Fix.** [`healthcare-network/lib/logic.js`](healthcare-network/lib/logic.js). Two helpers start from the **current** list and change exactly one entry; one shared function updates both sides of the consent:

```js
function addUnique(list, item) {            // copy current list, add only if missing
    const current = list ? list.slice() : [];
    if (!current.some(x => x.getIdentifier() === item.getIdentifier())) {
        current.push(getFactory().newRelationship(NS, item.getType(), item.getIdentifier()));
    }
    return current;
}

function removeById(list, item) {           // keep everyone except this one
    return (list || []).filter(x => x.getIdentifier() !== item.getIdentifier());
}

async function changeConsent(patientField, provider, grant) {
    const patient = currentPatient();       // must be a Patient
    patient[patientField] = grant ? addUnique(patient[patientField], provider)
                                  : removeById(patient[patientField], provider);
    provider.patients     = grant ? addUnique(provider.patients, patient)
                                  : removeById(provider.patients, patient);
    // ...update both registries
}
```

All six transactions (`Grant/RevokeAccessTo/FromClinician|Lab|Trainer`) are now one-line calls to `changeConsent`, so the bug cannot come back in just one of them.

**Verified by tests:** "granting a second clinician keeps the first one", "a second patient granting a clinician keeps the first patient", "granting the same clinician twice does not duplicate", "revoking one clinician keeps the others", "revoking one lab keeps the other lab".

### 3. Random record IDs

**Problem.** `lib/logic.js:167` and `:232` built IDs with `Math.random()`:

```js
var recordId = generateRecordId(32);   // different on every peer that endorses
```

Each endorsing peer runs the transaction on its own. Different peers produce different IDs and different write sets, so the endorsements don't match and the transaction fails once there is more than one peer.

**Fix.** The ID is the transaction ID, which is the same on every peer:

```js
const recordId = recordData.getIdentifier();             // InitialMedicalRecord
getFactory().newResource(NS, 'WearableData', wearableData.getIdentifier());  // SendWearableData
```

`generateRecordId` was deleted. **Test:** "an authorised clinician creates a record keyed by the transaction ID".

### 4. Trainer access only on the trainer side

**Problem.** `GrantAccessToTrainer` wrote only `trainer.patients`. The `Patient` had no list of trainers, so a patient could not see which trainers they had authorised.

**Fix.**
* Model ([`models/org.healthcare.com.cto`](healthcare-network/models/org.healthcare.com.cto)): added `--> PersonalTrainer[] authorizedTrainers optional` to `Patient`.
* Trainers use the same `changeConsent` path as clinicians and labs, so both sides stay in sync.

**Test:** "trainer access is recorded on the patient side too".

### 5. Wrong "last consultation" on update

**Problem.** Original `lib/logic.js:210`:

```js
recordData.medicalRecord.lastConsultationWith = recordData.medicalRecord.author;  // the PREVIOUS author
recordData.medicalRecord.author = invokingParticipant;
```

**Fix.** `lastConsultationWith` and `author` are both set to the clinician doing the update. `UpdateMedicalRecord` also checks that this clinician is still authorised by the patient. `InitialMedicalRecord` now refuses to overwrite an existing record.

**Test:** "a second clinician can update; lastConsultationWith is the updater; revoked clinician cannot".

### 6. Doctors and labs could add patients to themselves

**Problem.** `permissions.acl:164` (and `LabsOnlySeeThemselves` at `:248`):

```
rule CliniciansOnlySeeThemselves {
  participant(t): "org.healthcare.com.Clinician"
  operation: ALL                                   // includes UPDATE
  resource(v): "org.healthcare.com.Clinician"
  condition: (v.getIdentifier() == t.getIdentifier())
  action: ALLOW
}
```

A doctor could update their own record, put any patient into `patients`, and then rule `LimitAccessToAutorizedClinician` (which trusts `h.patients`) let them read that patient's medical record. This bypassed the patient's consent entirely. `ClinicianUpdatePatient` (`:182`) also let a doctor edit any field of their patients, including the patient's own access lists.

**Fix.** [`healthcare-network/permissions.acl`](healthcare-network/permissions.acl):

```
rule CliniciansReadThemselves {
  participant(t): "org.healthcare.com.Clinician"
  operation: READ                                  // read-only now
  resource(v): "org.healthcare.com.Clinician"
  condition: (v.getIdentifier() === t.getIdentifier())
  action: ALLOW
}
```

The same change applies to labs and trainers. A doctor may update a patient only while running `InitialMedicalRecord`, and only to link the new record (`ClinicianLinksRecordToPatient`). The **only** way onto a provider's `patients` list is now a patient-signed consent transaction.

**Tests:** "a clinician cannot add a patient to their own list", "a lab cannot add a patient to its own list". The first was also confirmed on a live Fabric 1.2 network, where it was rejected with `AccessException … does not have 'UPDATE' access`.

### 7. Patients could change any doctor's list

**Problem.** `permissions.acl:74`:

```
rule PatientsUpdateClinicians {
  participant: "org.healthcare.com.Patient"
  operation: READ, UPDATE
  resource: "org.healthcare.com.Clinician"     // ANY clinician, no condition
  action: ALLOW
}
```

The same applied to labs and trainers. A patient could rewrite another doctor's patient list directly, outside any transaction.

**Fix.**
* Model: the six grant/revoke transactions now extend a new `abstract transaction ConsentTransaction`.
* ACL: a patient may `UPDATE` a provider **only inside the matching transaction** and **only the provider named in it**:

```
rule PatientGrantsClinician {
  participant: "org.healthcare.com.Patient"
  operation: UPDATE
  resource(c): "org.healthcare.com.Clinician"
  transaction(tx): "org.healthcare.com.GrantAccessToClinician"
  condition: (tx.authorizedClinician.getIdentifier() === c.getIdentifier())
  action: ALLOW
}
```

Patients can also update their *own* participant record only inside a `ConsentTransaction` (`PatientsUpdateThemselvesViaConsent`), so the two sides of a consent cannot drift apart.

**Tests:** "a patient cannot edit an arbitrary clinician directly", "a patient cannot edit their own access list outside a consent transaction", "a clinician cannot submit a consent transaction".

### 8. Smart bands could write for any patient

**Problem.** `permissions.acl:303` and `:311`:

```
rule PostWearableData { participant: "...Wearable"  operation: CREATE  resource: "...SendWearableData"  action: ALLOW }
rule WearableData     { participant: "...Wearable"  operation: ALL     resource: "...WearableData"      action: ALLOW }
```

Any band could post readings for any patient (owner and device came from the request), and could update or delete every reading in the system.

**Fix.**
* Model: `Wearable` now has `--> Patient owner`, which is set when the device is registered (paired).
* ACL: the band may only `CREATE`, only as itself, and only for its own patient. There are no update or delete rights:

```
rule WearablesSubmitOwnReadings {
  participant(w): "org.healthcare.com.Wearable"
  operation: CREATE
  resource(tx): "org.healthcare.com.SendWearableData"
  condition: (tx.device.getIdentifier() === w.getIdentifier()
              && tx.owner.getIdentifier() === w.owner.getIdentifier())
  action: ALLOW
}
```

* Logic: `SendWearableData` performs the same checks again, as defence in depth.

**Tests:** "a band cannot submit readings for another patient", "a band cannot impersonate another band", "a band cannot modify or delete stored readings". Also confirmed live: the simulator's posts for Alice were accepted and its posts for Bob were rejected with `AccessException`.

### 9. Transaction history readable by everyone

**Problem.**
* `SystemACL` (`:346`) gives every participant `ALL` on `org.hyperledger.composer.system.**`, which includes every `HistorianRecord`, and those contain full transaction data.
* `PatientsOwnHistory` (`:39`) only restricted *patients*, so clinicians, labs, trainers and bands could read everyone's history.

**Fix.** A `DENY` rule placed **before** `SystemACL` for every participant type in the network:

```
rule OnlyOwnHistory {
  participant(t): "org.healthcare.com.*"
  operation: READ
  resource(v): "org.hyperledger.composer.system.HistorianRecord"
  condition: (!v.participantInvoking || v.participantInvoking.getIdentifier() !== t.getIdentifier())
  action: DENY
}
```

**Test:** "a patient cannot read another participant's historian records".

### 10. Secrets in the repository

**Problem.**
* Seven identity cards (`alex_patient.card`, `jack_clinician.card`, `smart_band.card`, `networkadmin.card`, `restadmin.card`, …) were committed. Each card holds a private key or enrollment secret.
* `wearable_simulator.py:6` contained a hard-coded REST API access token.

**Fix.**
* All `.card` files deleted. `scripts/network.sh seed` issues fresh identities locally into `.composer-home/`, which is git-ignored.
* `.gitignore` excludes `*.card`, `.composer-home/` and `dist/`.
* The simulator takes the token from `--token` or `WEARABLE_API_TOKEN` and the IDs from arguments. Nothing secret remains in the file.
* Repository level: [`.gitleaks.toml`](.gitleaks.toml) with rules for Composer cards, Fabric private keys and REST tokens. It runs in [CI](.github/workflows/ci.yml) and as a [pre-commit hook](.pre-commit-config.yaml).

> **The old secrets are still in the upstream git history.** Anyone who used those identities must treat them as compromised.

### 12. Template tests instead of real tests

**Problem.** `test/logic.js` and `features/sample.feature` were the Composer generator's sample tests. They referenced `SampleAsset`, `SampleParticipant` and `SampleTransaction`, none of which exist in this model, so they failed straight away and tested nothing.

**Fix.**
* Deleted the template feature files and the cucumber dependencies.
* Rewrote `test/logic.js`: **23 tests** run on Composer's embedded runtime. Every participant has its own identity, so the logic **and** the ACL are both exercised. Groups: consent, security, medical records, wearables, history.
* Proof that the tests are meaningful: run against the **original** `logic.js` + `permissions.acl`, **18 of the 23 fail**.

### 13. The application could no longer be installed or run

| Problem | Cause | Fix |
|---|---|---|
| `npm install` fails | Every dev dependency was `"latest"` (mocha, eslint, nyc… no longer support Node 8) | Pinned versions in `package.json` (Composer 0.20.9, mocha 5.2, eslint 5.16, chai 4.2); `package-lock.json` committed |
| Composer needs Node 8 | Composer 0.20 is deprecated | Everything runs in pinned Docker images: `node:8` for tests; [`docker/composer-tools.Dockerfile`](healthcare-network/docker/composer-tools.Dockerfile) for the CLI, REST server and Playground |
| `composer network start` → `npm: not found` | The Fabric 1.2 peer builds chaincode with `fabric-ccenv:latest`, which on a modern machine is a Go-only Fabric 2.x/3.x image | `CORE_CHAINCODE_BUILDER=hyperledger/fabric-ccenv:1.2.1` in `fabric-tools/fabric-scripts/hlfv12/composer/docker-compose.yml` |
| `composer-rest-server` → `ReferenceError: File is not defined` | Unpinned transitive dependency `swagger-client` now requires Node 18+ | Pinned `swagger-client@3.8.25` inside the tools image |
| `docker-compose` not found | Compose v1 was removed from Docker | New [`scripts/network.sh`](healthcare-network/scripts/network.sh) uses `docker compose`, and wraps up / deploy / seed / rest / playground / down |
| Simulator crashes | Python 2 syntax (`print("…").format(…)`) | Rewritten for Python 3 with arguments, a `--count` option and readable error messages |
| `.bna` out of date | Committed build artefact (`healthcare-network@0.7.0.bna`) | Removed; built into `dist/` by `npm run prepublish` / `network.sh deploy`. Version bumped to 0.8.0 |
| Lint failed (89 errors) | Inconsistent indentation | Code rewritten to the project's own ESLint rules; `npm run lint` passes |

---

## Part B — Improvements that needed the redesign (`healthcare-fabric/`)

These are the six recommendations from the presentation ("Six Things to Fix" and "Technical Solutions"), implemented on Hyperledger Fabric 2.5.

### Fix 1 — Sharing logic that cannot break

Instead of arrays on participants, **each consent is its own ledger entry**, keyed by `(patientId, providerId)`. A grant or revoke writes exactly one key, so it is structurally impossible to affect another provider.
→ `grantAccess` / `revokeAccess` in [`chaincode/lib/healthcareContract.js`](healthcare-fabric/chaincode/lib/healthcareContract.js)

### Fix 2 — Tight access control

* **Identity from the certificate.** Who the caller is comes from the X.509 certificate (`hc.role`, `hc.id` attributes issued by the organisation's CA) and the MSP, never from transaction arguments. At registration the ID is bound to its MSP, so another organisation's CA cannot impersonate it.
* **Scoped consent.** Each consent lists scopes (`records:read`, `records:write`, `lab:write`, `details:read`, `wearable:read`). Each provider type has a maximum set: for example, a trainer can never get medical records ([`lib/roles.js`](healthcare-fabric/chaincode/lib/roles.js)).
* **Expiry.** Every consent must expire, after at most one year. Expiry is checked against the transaction timestamp, which is deterministic.
* **Endorsement.** The policy is `AND('Org1MSP.peer','Org2MSP.peer')`: no single organisation can change data on its own.

### Fix 3 — Encrypted records off-chain, hash on-chain

* **Medical records and lab results** are encrypted with AES-256-GCM using a per-patient key, which is itself wrapped by a master key. They are stored off-chain. The ledger keeps only the SHA-256 of the ciphertext and a pointer ([`gateway/src/vault.js`](healthcare-fabric/gateway/src/vault.js)).
* **Tamper detection.** Before decrypting, the gateway compares the blob's hash with the ledger and refuses on mismatch (HTTP 409).
* **Private data collection.** Personal details (name, email, date of birth) go into a Fabric private data collection, so only their hash enters blocks.
* **Right to erasure.** `eraseMyDetails` uses Fabric 2.5 `purgePrivateData`, and the gateway deletes the patient's data key (crypto-shredding), so every off-chain copy becomes unreadable.

### Fix 4 — Usable apps

* **REST gateway** ([`gateway/`](healthcare-fabric/gateway/)): login is required, and each user's requests are signed with **their own** Fabric identity.
* **Web dashboard** with patient, clinician, lab and trainer views: grant or revoke with a date picker, records, access log, wearables, personal details, emergency access.

### Fix 5 — Modern platform, several organisations

* **Platform:** Fabric 2.5.16 LTS, Fabric CA 1.5.22, `fabric-contract-api`, the Fabric Gateway SDK and the chaincode lifecycle (upgrades via `CC_SEQUENCE`).
* **Organisations:** two (Org1 = hospital, Org2 = lab/wellness), each with its own CA, peer and CouchDB, plus a Raft orderer ([`network/network.sh`](healthcare-fabric/network/network.sh)).

### Fix 6 — Clean-up: secrets, real tests, batched wearable data

* **Secrets:** see issue 10. Wallets, passwords and off-chain data are git-ignored; passwords are random and stored as scrypt hashes.
* **Tests:** 38 chaincode unit tests, 10 gateway tests, and 14 end-to-end checks against the live network.
* **Wearable batching:** the band buffers readings and sends one batch. The gateway re-checks its Merkle root, stores the raw readings encrypted, and records **one** transaction with the root and summary statistics. Any single reading can later be proven with a Merkle proof ([`gateway/src/merkle.js`](healthcare-fabric/gateway/src/merkle.js), [`simulator/`](healthcare-fabric/simulator/)).

### Missing features that were added

| Missing in the original | Now |
|---|---|
| Labs could not upload results | `addLabResult` (needs `lab:write`) |
| Access never expired | Mandatory expiry on every consent |
| No emergency process | `emergencyAccess`: clinician only, reason required, 24 h, read-only, logged and shown to the patient, revocable by the patient |
| No log of who viewed a record | Reading content requires the `accessRecord` transaction, which writes an audit entry; `getAccessLog` shows who, when, why, and under which grant |
| No files (scans, PDFs) | Records are arbitrary encrypted documents off-chain; only the hash is on the ledger |
| No version history | `getRecordHistory` (ledger history of each record, every version with its author) |
| Devices could not be removed | `unpairWearable` |

---

## Bugs found and fixed while building this

Testing on real networks surfaced a few more problems, all now fixed:

* **Record history order.** Fabric returns key history newest-first. The chaincode now returns it in chronological order, and the unit-test mock behaves like Fabric so this stays covered.
* **Unordered lists.** The access log and wearable batches were ordered by transaction ID. They are now sorted by time.
* **CouchDB start-up race.** CouchDB 3 can reject the peer (HTTP 401) for a moment after it starts. `network.sh up` detects the exited peer and restarts it before creating the channel.
* **Gateway Node version.** `@hyperledger/fabric-gateway` 1.12 needs Node ≥ 22.12. This is declared in `engines` and `.nvmrc`.

---

## Verification summary

| What | Result |
|---|---|
| Composer tests on the fixed code | 23 / 23 pass |
| Same tests on the original code | 18 / 23 fail (bugs reproduced) |
| Composer app on a live Fabric 1.2 network | deploy, seed, consent, record, REST API, simulator work; self-adding a patient and writing for another patient are rejected |
| Fabric 2.5 chaincode unit tests | 38 / 38 pass |
| Gateway unit tests (encryption, tamper detection, crypto-shredding, Merkle) | 10 / 10 pass |
| End-to-end on a fresh Fabric 2.5 network | 14 / 14 checks pass |
| Lint (all three projects) | clean |
