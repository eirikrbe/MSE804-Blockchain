'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEST_NETWORK = process.env.HC_TEST_NETWORK
    || path.resolve(ROOT, '../network/.fabric/fabric-samples/test-network');
const orgs = path.join(TEST_NETWORK, 'organizations/peerOrganizations');

module.exports = {
    port: Number(process.env.PORT || 3000),
    channel: process.env.HC_CHANNEL || 'healthchannel',
    chaincode: process.env.HC_CHAINCODE || 'healthcare',
    walletDir: process.env.HC_WALLET || path.join(ROOT, 'wallet'),
    dataDir: process.env.HC_DATA || path.join(ROOT, 'data'),
    // Each organisation's users talk to their own organisation's peer.
    peers: {
        Org1MSP: {
            endpoint: process.env.HC_ORG1_PEER || 'localhost:7051',
            hostAlias: 'peer0.org1.example.com',
            tlsCert: path.join(orgs, 'org1.example.com/peers/peer0.org1.example.com/tls/ca.crt'),
        },
        Org2MSP: {
            endpoint: process.env.HC_ORG2_PEER || 'localhost:9051',
            hostAlias: 'peer0.org2.example.com',
            tlsCert: path.join(orgs, 'org2.example.com/peers/peer0.org2.example.com/tls/ca.crt'),
        },
    },
    jwtTtl: process.env.HC_JWT_TTL || '1h',
};
