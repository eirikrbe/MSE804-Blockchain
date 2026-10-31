# Hyperledger Composer 0.20 only runs on Node 8. Pin everything so the
# toolchain keeps working even though the project is deprecated.
FROM node:8

RUN npm install -g --unsafe-perm \
        composer-cli@0.20.9 \
        composer-rest-server@0.20.9 \
        composer-playground@0.20.9 \
    && npm cache clean --force

# loopback -> strong-globalize -> g11n-pipeline asks for swagger-client ^3.8.3,
# which now resolves to a release that needs Node >= 18 ("File is not defined").
# Pin a 2018-era release that still runs on Node 8.
RUN cd /usr/local/lib/node_modules/composer-rest-server/node_modules/g11n-pipeline \
    && npm install --no-save --production swagger-client@3.8.25 \
    && npm cache clean --force

WORKDIR /network
