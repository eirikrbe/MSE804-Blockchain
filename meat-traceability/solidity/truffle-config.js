module.exports = {
  networks: {
    // `truffle develop` (Ganache on 9545). In MetaMask add a network with
    // RPC URL http://127.0.0.1:9545 and chain ID 1337.
    develop: {
      host: '127.0.0.1',
      port: 9545,
      network_id: 5777,
    },
    // A running Ganache (GUI or `ganache --port 7545`), used with
    // `truffle migrate --network ganache`. `truffle test` starts its own.
    ganache: {
      host: '127.0.0.1',
      port: 7545,
      network_id: '*',
    },
  },
  compilers: {
    solc: {
      version: '0.8.38',
      settings: {
        optimizer: { enabled: true, runs: 200 },
        // Ganache 7 does not support the newest EVM opcodes.
        evmVersion: 'paris',
      },
    },
  },
};
