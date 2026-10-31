# healthcare-network (Hyperledger Composer 0.20 — fixed)

This project proposes a decentralized solution based on blockchain to enable the exchange and use of the data obtained from all the devices associated with patients in a safe, fast and transparent way.

This is the original Composer business network with its sharing-logic bugs and access-rule leaks fixed, real tests, and scripts that run it on a local Fabric 1.2 network in Docker.

* Model: `models/org.healthcare.com.cto` · Logic: `lib/logic.js` · Access rules: `permissions.acl` · Queries: `queries.qry`
* Tests: `test/logic.js` (23 tests, embedded runtime)
* Run: `scripts/network.sh up | deploy | seed | rest | playground | cli | down`

See the [main README](../README.md#3-quick-start--original-composer-version-fixed) for setup, the list of fixes and troubleshooting. The recommended Fabric 2.5 redesign is in [`../healthcare-fabric`](../healthcare-fabric).
