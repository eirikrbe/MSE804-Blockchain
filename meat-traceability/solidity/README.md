# MeatTrace: Solidity version

The same beef and lamb traceability design as the Fabric chaincode in `../chaincode`, written as one Solidity contract (`contracts/MeatTrace.sol`), plus a MetaMask dApp. It is meant for a **permissioned EVM network** run by a consortium (for example Hyperledger Besu with QBFT). Project mBridge uses the same model: Solidity contracts on a permissioned EVM ledger.

Every business in the tests, demo and seed data is fictional.

## Run the tests (Truffle + built-in Ganache)

```bash
conda activate blockchain
cd meat-traceability/solidity
npm install                       # ethers + lite-server for the dApp
truffle test                      # 27 tests
truffle test demo/walkthrough.js  # end-to-end story with the gas used per step
```

## Run the dApp with MetaMask

1. **Start a chain and deploy:**
   ```bash
   truffle develop                 # keep this terminal open; it prints 10 accounts and private keys
   truffle(develop)> migrate
   truffle(develop)> exec scripts/seed.js
   ```
   The seed script registers the businesses and creates demo lots. Accounts: 0 admin, 1 farm A, 2 farm B, 3 plant, 4 certifier, 5 DC, 6 store, 7 regulator, 8 truck sensor.
2. **MetaMask:** add a network with RPC URL `http://127.0.0.1:9545` and chain ID `1337`. Then import the private keys of the accounts you want to act as (for example 6 store, 3 plant, 7 regulator) from the `truffle develop` output.
3. **Serve the page:** in a second terminal, `npm run dev`, then open http://localhost:3000.
4. **Try it:**
   - Scan `P-STEAK-1` (halal), `P-MINCE-1` (halal dropped because inputs were mixed) or `C-2` (carcass).
   - As the plant, recall `C-1` and scan the mince again.
   - As the store, try to register cattle and see the contract refuse ("only farms register animals").

If you restart `truffle develop`, run `migrate --reset` and the seed again. MetaMask may also need "Clear activity tab data" for that account.

## Use it in Remix

Paste `contracts/MeatTrace.sol` into Remix. In the compiler's **Advanced configurations**, tick **Enable optimization** (200 runs). Without the optimizer the contract is about 38 KB, over the 24 KB limit, and will not deploy. With it, it is about 22 KB.

## What each part shows

| Feature | Function | Report section |
|---|---|---|
| Consortium admin onboards each business with a role and NZBN; the caller's role always comes from the registry | `registerParticipant` | Task 1 (identity, governance) |
| Beef by NAIT numbers, lamb by ASD reference; both stored only as a **hash** (no personal data on-chain) | `registerBeefLot`, `registerLambLot` | Task 1 (privacy), Task 2 (data points) |
| Halal credential issued by a certifier to a plant, with expiry, revocation and a hash of the certificate | `issueCredential`, `revokeCredential` | Task 1 (verification) |
| Halal claim from slaughter to each cut; dropped when halal and non-halal meat are mixed | `slaughter`, `splitLot`, `mergeLots` | Task 1, Task 3 |
| Mass balance and process-once rules | `slaughter`, `splitLot`, `mergeLots` | Task 1 (data quality) |
| Sensors submit Merkle-rooted batches; an excursion quarantines; the contract can verify a single reading with `sha256`, matching the off-chain JavaScript | `submitColdChainBatch`, `verifyReading` | Task 2 (cryptography) |
| One recall reaches every product made from a carcass | `recall` | Task 3 (efficiency) |
| Checkout check | `checkSaleable` | Task 2 (point of sale) |
| Gas per operation | `demo/walkthrough.js` | Task 2.3, Task 3 (cost, scalability) |

## Assumptions and limits

- **Public chains would expose everything.** On Ethereum mainnet every lot, weight and supplier relationship would be public. That is why the design targets a permissioned EVM network, with private transactions (for example Besu with Tessera) for commercial data.
- **The admin role is a central point.** In this prototype one account onboards businesses. A real consortium would split this, for example a multi-signature admin or each member onboarding its own suppliers. That is a governance point for the report.
- **Recalls walk at most 256 lots per call** (`MAX_WALK`). Larger recalls would be split across calls, or traced off-chain from the events.
- **Gas figures come from Ganache.** A permissioned network does not charge fees in ETH, but gas still measures how much work each step is.
- **Thresholds are assumptions.** 4 °C and 30 minutes are placeholders, not regulatory limits.
