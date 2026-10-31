# healthcare-fabric (Hyperledger Fabric 2.5)

The healthcare network redesigned for Fabric 2.5. It adds per-pair consent with scopes and expiry, encrypted off-chain records with on-chain hashes, emergency access, an access log, lab uploads, purgeable private personal data, Merkle-batched wearable data, per-user identities, a REST gateway and a web dashboard.

```bash
./network/network.sh up        # Fabric 2.5.16: 2 orgs, CAs, CouchDB, channel, chaincode
./network/network.sh enroll    # demo users with hc.role / hc.id certificate attributes
cd gateway && npm install && npm start      # http://localhost:3000  (Node 22.12+)
npm run e2e                                  # 14 end-to-end checks
```

Full documentation: [main README](../README.md#2-quick-start--fabric-25-version-recommended).
