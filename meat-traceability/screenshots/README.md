# Test evidence

Ganache at 127.0.0.1:7545 (network 5777, shown in MetaMask as "Ganache 7545"). Ganache account roles come from `scripts/seed.js` (Plant 0x49d3…A289, Store 0x607E…451F, Regulator 0xbE74…403b).

## Automated tests (3 Nov 2026, final code)

| File | Command | Result |
|---|---|---|
| `solidity-truffle-test.txt` | `truffle test` | 29 passing |
| `solidity-walkthrough.txt` | `truffle test demo/walkthrough.js` (story and gas per step, for Table 4) | 1 passing |
| `chaincode-npm-test.txt` | Fabric chaincode `npm test` | 30 passing |
| `chaincode-demo.txt` | Fabric chaincode `npm run demo` | runs to the recall |

## dApp: scans before any recall (2 Nov 2026, Store account)

| File | What it shows |
|---|---|
| `dapp-scan-P-STEAK-1.jpg` | OK to sell, halal certificate valid, made from C-1 ← A-BEEF-1 |
| `dapp-scan-P-MINCE-1.jpg` | OK to sell, no halal claim (halal and non-halal inputs mixed), from both farms |
| `dapp-scan-C-2.jpg` | Carcass, not a retail product, held by the plant |
| `dapp-scan-A-LAMB-1.jpg` | Live lambs at farm A, start of the chain |

## dApp: access control (2 Nov 2026, Store account)

| File | What it shows |
|---|---|
| `dapp-store-refused-register-cattle.jpg` | Store registers cattle → "only farms register animals" |
| `dapp-store-refused-all-actions.jpg` | Store tries every action it lacks the role for; each refusal shows the contract's reason |

| Action (as Store) | Contract's reason |
|---|---|
| Register a business | only the consortium admin registers participants |
| Register cattle | only farms register animals |
| Register lambs | only farms register animals |
| Hand over C-2 | caller does not hold this lot |
| Issue a halal credential | only certifiers issue credentials |
| Slaughter A-LAMB-1 | only processors slaughter |
| Cut and pack from C-2 | only processors cut and pack |
| Recall C-2 | only the regulator can recall product you neither processed nor hold |
| Release quarantine P-STEAK-1 | only the regulator releases quarantine |
| Scan X-NOPE | lot does not exist |

## dApp: recall (3 Nov 2026, final contract 0x7d73…E4AC)

| File | What it shows |
|---|---|
| `recall-1-plant-recall-C-1-request.png` | Plant recalls C-1 ("E. coli detected in carcass sample"); MetaMask transaction request |
| `recall-2-plant-recall-C-1-confirmed-block-76.png` | Confirmed in block 76 (gas 344,760); C-1 scans as recalled |
| `recall-3-scan-P-STEAK-1-recalled.png` | P-STEAK-1: "Do not sell: recalled: E. coli detected in carcass sample" |
| `recall-4-scan-P-MINCE-1-recalled.png` | P-MINCE-1: "Do not sell", reached through P-TRIM-1 |
| `recall-5-scan-C-2-not-affected.png` | C-2, the other carcass from the same animals: still OK |
| `recall-6-regulator-recall-C-1-refused.png` | Regulator recalls C-1 again → "lot is already recalled" |

Chain state after the recall (read from the contract): one `Recalled` event, block 76, from the Plant, reaching C-1, P-STEAK-1, P-TRIM-1 and P-MINCE-1.

| Lot | Relation to C-1 | Status |
|---|---|---|
| C-1 | recalled lot | Recalled |
| P-STEAK-1 | cut from C-1 | Recalled |
| P-TRIM-1 | cut from C-1 | Recalled |
| P-MINCE-1 | made from P-TRIM-1 and C-9 | Recalled |
| C-2 | other carcass from the same animals | OK |
| C-9 | farm B carcass in the mince | OK |
| A-BEEF-1, B-BEEF-1, A-LAMB-1 | live animals | OK |

The gas in `recall-2` (344,760) is the dApp's recall on the seeded chain. Table 4 uses the walkthrough's figure (327,660), which runs the same recall in the test scenario.

## Code changes behind this evidence

1. `app/app.js`: the Activity panel shows the contract's revert reason instead of MetaMask's "Internal JSON-RPC error".
2. `recall()` refuses a lot that is already recalled ("lot is already recalled"), in Solidity and the chaincode.
3. A later recall keeps the first reason on lots an earlier recall already caught, in Solidity and the chaincode.
