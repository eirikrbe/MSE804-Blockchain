'use strict';

const app = require('./src/app');
const config = require('./src/config');
const fabric = require('./src/fabric');

const server = app.listen(config.port, () => {
    console.log(`Healthcare gateway on http://localhost:${config.port} (channel ${config.channel}, chaincode ${config.chaincode})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close();
        fabric.close();
        process.exit(0);
    });
}
