# Beef and lamb traceability: prototype

Prototype for MSE804 Assessment 2 (blockchain food traceability for Woolworths NZ). It follows beef and lamb from farm to checkout, with halal certificates, cold-chain sensors and one-call recalls. There are two implementations of the same design:

- **`solidity/`**: a Solidity contract with Truffle tests, a gas walkthrough and a MetaMask dApp. This is the one to use for the course. See `solidity/README.md`.
- **`chaincode/`**: a Hyperledger Fabric version (`fabric-contract-api`, Node.js), described below. Use it in the report as the alternative design you compared.

Every business in the tests and demo is fictional.

## What it shows

| Feature | Where | Report section |
|---|---|---|
| Identity from the certificate (`tr.role`, `tr.id`, MSP), never from arguments; NZBN on each participant | `registerParticipant`, `_requireCaller` | Task 1 (decentralised identity), Task 2 (crypto) |
| Beef lots carry NAIT animal numbers; lamb lots carry an ASD reference and head count | `registerAnimalLot` | Task 2 (data points) |
| Halal as a credential a certifier issues to a plant, with expiry and revocation | `issueCredential`, `revokeCredential` | Task 1 (identity, verification) |
| Halal claim carried from slaughter to every cut, and dropped when halal and non-halal inputs are mixed | `slaughterLot`, `splitLot`, `mergeLots` | Task 1, Task 3 (what blockchain can and cannot prove) |
| Mass balance: products cannot outweigh their inputs, and a lot can be processed only once | `slaughterLot`, `splitLot`, `mergeLots` | Task 1 (data quality) |
| Cold-chain sensors with their own identities submit one Merkle-rooted batch per window; an excursion quarantines the lot | `submitColdChainBatch`, `src/merkle.js` | Task 2 (crypto, scalability) |
| One recall call walks from a carcass to every pack made from it and reports who holds each | `recall` | Task 3 (efficiency against traditional recalls) |
| Checkout check: recalled, quarantined, past use-by or revoked halal means "do not sell" | `checkSaleable` | Task 2 (point-of-sale integration) |
| Shopper's QR view with business names only, no personal data | `getProvenance` | Task 1 (privacy) |

## Run it

Uses the Node.js in the conda `blockchain` environment. The test runner (mocha 12) needs Node 20.19 or later, or 22.12 or later; check with `node -v`.

```bash
conda activate blockchain
cd meat-traceability/chaincode
npm install
npm test          # 28 unit tests
npm run demo      # farm → plant → DC → store, a temperature excursion and a recall
```

The tests and demo run the contract against an in-memory ledger (`test/mockContext.js`) that behaves like Fabric in the two ways that matter here: a transaction does not see its own writes, and a failed transaction writes nothing.

## Layout

```
chaincode/
├── index.js                 contract entry point for Fabric
├── src/traceContract.js     the smart contract
├── src/rules.js             roles, species, assumed thresholds
├── src/merkle.js            Merkle root / proof / batch summary for sensor readings
├── test/                    mock Fabric context and 28 unit tests
└── scripts/demo.js          end-to-end walk-through
```

## Assumptions and limits

- **Thresholds are assumptions.** 4 °C and 30 minutes (`src/rules.js`) are placeholders, not regulatory limits. A processor can set `maxTempC` per product.
- **Two organisations only.** `Org1MSP` (retailer side) and `Org2MSP` (supply side) mirror the Fabric test network. A real network would give certifiers and the regulator their own organisations or read-only access.
- **Not modelled:** partial use of a carcass, GTIN check digits, NZBN validation beyond 13 digits, the off-chain store for raw sensor readings, the REST gateway and consumer app.
- **Not yet deployed.** It runs on the mock ledger. Deploying to the Fabric 2.5 test network can reuse `../BlockchainHealthcare-master/healthcare-fabric/network/network.sh` with this chaincode and the `tr.role` / `tr.id` attributes.
