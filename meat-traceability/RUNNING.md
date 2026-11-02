# Running the MeatTrace prototype

Step-by-step instructions for both versions of the prototype on this Mac.

| Version | Folder | What you can run |
|---|---|---|
| **Solidity** (main design) | `solidity/` | Tests, the recall walkthrough, and the MetaMask dApp (front end) |
| **Fabric chaincode** (compared alternative) | `chaincode/` | Tests and a terminal demo. No front end. |

---

## 0. Before you start

- **Use the conda environment.** Truffle (v5.11.5, with Ganache 7.9.1 built in) and Node 20 live there:
  ```bash
  conda activate blockchain
  node -v        # must be 20.19 or later (mocha 12 needs it)
  ```
- **Ganache app** (the desktop GUI): the same one used for the pet shop tutorial. It runs on `HTTP://127.0.0.1:7545`, network ID `5777`.
- **MetaMask** in Chrome, with a network already set up for Ganache (see section 3).

---

## 1. Fabric chaincode: tests and demo

No Fabric network, Docker or Ganache is needed. The tests and the demo use an in-memory ledger (`test/mockContext.js`).

```bash
conda activate blockchain
cd ~/Documents/GitHub/MSE804-Blockchain/meat-traceability/chaincode
npm install      # first time only
npm test         # 30 passing
npm run demo     # farm → plant → DC → store, a temperature excursion and a recall
```

Do **not** run `npm start`: it waits for a real Fabric peer.

---

## 2. Solidity: tests and walkthrough

`truffle test` starts its own temporary chain, so the Ganache app does not need to be open.

```bash
conda activate blockchain
cd ~/Documents/GitHub/MSE804-Blockchain/meat-traceability/solidity
npm install                         # first time only
truffle test                        # 29 passing (about 11 s)
truffle test demo/walkthrough.js    # the recall story, with gas used per step
```

The walkthrough's gas table is the source for Table 4 in the report.

---

## 3. Solidity: the dApp (front end) with Ganache and MetaMask

### 3.1 Start Ganache

Open the **Ganache** app and start (or open) a workspace. Check the header shows:
- RPC server `HTTP://127.0.0.1:7545`
- Network ID `5777`

### 3.2 Deploy the contract and load the demo data

Terminal 1:

```bash
conda activate blockchain
cd ~/Documents/GitHub/MSE804-Blockchain/meat-traceability/solidity
truffle migrate --network ganache
truffle exec scripts/seed.js --network ganache
```

If the contract was deployed before on this chain, use `truffle migrate --reset --network ganache`.

### 3.3 Serve the page

Terminal 2 (leave it running):

```bash
conda activate blockchain
cd ~/Documents/GitHub/MSE804-Blockchain/meat-traceability/solidity
npm run dev
```

Open **http://localhost:3000** in Chrome.

### 3.4 Set up MetaMask

**Network (first time only).** MetaMask allows only one network per chain ID. If you already have the pet shop network (chain ID `1337`, RPC `127.0.0.1:7545`), reuse it; do not add a second one. Otherwise add a network with:

| Field | Value |
|---|---|
| Network name | Ganache 7545 (shown in MetaMask screenshots, so make it match the port) |
| RPC URL | `http://127.0.0.1:7545` |
| Chain ID | `1337` |
| Currency symbol | ETH |

**Pick the network for this site.** In the MetaMask panel, next to **localhost:3000** at the bottom, click the gear icon and choose the Ganache network.

**Import the test accounts.** The seed script gives roles to Ganache's accounts in list order:

| Ganache index | Role | Import it? |
|---|---|---|
| 0 | Consortium admin | Optional |
| 1 | Farm A | Optional |
| 2 | Farm B | Optional |
| 3 | Processing plant | **Yes**, name it "Plant" |
| 4 | Halal certifier | Optional |
| 5 | Distribution centre | Optional |
| 6 | Store | **Yes**, name it "Store" |
| 7 | Regulator (MPI) | **Yes**, name it "Regulator" |
| 8 | Truck sensor | No |

For each one:
1. In Ganache, click the **key icon** on that row and copy the private key.
2. In MetaMask: open the account list, click **Add wallet** at the bottom, then **Import an account**, and paste the key. (In older MetaMask versions: **Add account or hardware wallet**, then **Private key**.) Do not use **Add account** under your own wallet: it creates a new account from your seed phrase instead of importing one.
3. Check the address matches the Ganache row, then rename the account to its role (⋮ menu, **Rename**).

Do not rename your own wallet's account to a role name. Only the imported Ganache addresses have roles on the contract.

### 3.5 Connect

1. Switch MetaMask to the **Plant** account.
2. Reload the page and click **Connect MetaMask**. Tick the imported accounts if MetaMask asks which to connect.
3. Under the button, the page should show the role (for example "Processor · …"). "Not registered" means the account is not one the seed set up.

### 3.6 Things to try

1. **Scan** `P-STEAK-1`: saleable, halal.
2. **Scan** `P-MINCE-1`: halal claim dropped, because halal and non-halal inputs were mixed.
3. As **Plant**, open **Recall**, recall `C-1` with the reason "E. coli detected in carcass sample", and confirm the transaction in MetaMask. The reason appears on every recalled pack, so use a realistic one for the report screenshots.
4. **Scan** `P-MINCE-1` again: now "Do not sell: recalled: E. coli detected in carcass sample". `P-STEAK-1` is recalled too; `C-2` (the other carcass) is not.
6. As **Regulator**, try to recall `C-1` again: the contract refuses ("lot is already recalled"). To reset the demo after a recall, rerun section 3.2 with `--reset`.
5. Switch to **Store**, open **Register cattle**, and submit: the contract refuses ("only farms register animals").

Every transaction, including refusals, appears in the **Activity** panel at the bottom of the page.

### 3.7 Screenshots for the report

| Screenshot | Where it goes |
|---|---|
| `truffle test` output (29 passing) | Task 2 |
| `truffle test demo/walkthrough.js` (story and gas table) | Task 2.3 |
| dApp: scan, recall, scan again | Task 2 |
| dApp: the store refused when registering cattle | Task 1 (identity and access control) |
| Chaincode `npm test` (30 passing) | Appendix (the compared alternative) |

---

## 4. Troubleshooting

| Problem | Cause and fix |
|---|---|
| Page says "MeatTrace is not deployed on network 1" | MetaMask is on Ethereum mainnet. Switch this site to the Ganache network (section 3.4). |
| Page says "not deployed on network 5777" | The contract is not on this chain. Run section 3.2 again. |
| MetaMask: "This Chain ID is currently used by …" | You already have a network with chain ID 1337. Use that one, or add `127.0.0.1:7545` as an extra RPC URL on it. |
| MetaMask: "Could not fetch chain ID" | Ganache is not running. Open the Ganache app. |
| Transactions fail with a nonce error after a restart | Ganache started a fresh chain. In MetaMask: Settings › Advanced › **Clear activity tab data**, for each imported account. Then rerun section 3.2 with `--reset`. |
| Activity shows "Internal JSON-RPC error." | The page is an old copy from before the error-reason fix. Reload it (lite-server serves the current `app.js`). |
| Recall refused: "lot is already recalled" | That lot was recalled earlier on this chain. Rerun section 3.2 with `--reset` to start the demo again. |
| MetaMask shows the network as "Localhost 8545" | The network's name is wrong but its RPC URL is right (the transactions still reach Ganache). Rename it in MetaMask: Settings › Networks › that network › Network name. |
| Role shows "not registered" | You are on an account the seed did not use (for example your own wallet). Switch to an imported Ganache account. |
| Everything is gone after reopening Ganache | A **Quickstart** workspace starts a new chain each time, with new accounts. Rerun section 3.2 and re-import the keys, or save the workspace in Ganache to keep it. |
| `npm test` in `chaincode/` fails to start | Node is older than 20.19. Run `conda activate blockchain` and check `node -v`. |

---

## 5. Safety

- Use the imported Ganache accounts only on localhost. Never send real funds to them.
- Keep your real MetaMask wallet out of the demo. On the Ganache network it has no ETH, so it cannot sign anything useful anyway.
- Ganache keys and mnemonics are local test values; they are safe to show in screenshots, but do not reuse them anywhere else.
