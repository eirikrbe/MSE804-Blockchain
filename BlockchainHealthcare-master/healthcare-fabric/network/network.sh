#!/usr/bin/env bash
#
# Fabric 2.5 network for the healthcare chaincode, built on fabric-samples'
# test-network: two organisations (Org1 = hospital, Org2 = lab / wellness),
# one peer each, Raft orderer, Fabric CAs and CouchDB.
#
#   ./network.sh up        download Fabric (first run), start network, create channel, deploy chaincode
#   ./network.sh deploy    (re)deploy the chaincode, bumping the sequence  (CC_VERSION / CC_SEQUENCE env)
#   ./network.sh enroll    register + enroll the demo users in users.conf with hc.role / hc.id attributes
#   ./network.sh down      stop everything and delete ledger data, crypto material and the wallet
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
FABRIC_HOME="$HERE/.fabric"
SAMPLES="$FABRIC_HOME/fabric-samples"
TEST_NET="$SAMPLES/test-network"
WALLET="$ROOT/gateway/wallet"

FABRIC_VERSION=2.5.16
CA_VERSION=1.5.22
SAMPLES_COMMIT=5789681b4f4d24e58fa40f19a69f5496892374b6
CHANNEL=healthchannel
CC_NAME=healthcare
CC_VERSION="${CC_VERSION:-1.0}"
CC_SEQUENCE="${CC_SEQUENCE:-1}"
# Every organisation must endorse: no single org can change a patient's data alone.
CC_POLICY="AND('Org1MSP.peer','Org2MSP.peer')"

export PATH="$SAMPLES/bin:$PATH"
export FABRIC_CFG_PATH="$SAMPLES/config"

download() {
    if [ -x "$SAMPLES/bin/peer" ]; then
        return
    fi
    mkdir -p "$FABRIC_HOME"
    if [ ! -d "$SAMPLES" ]; then
        git clone -q https://github.com/hyperledger/fabric-samples.git "$SAMPLES"
        git -C "$SAMPLES" checkout -q "$SAMPLES_COMMIT"
    fi
    curl -sSL -o "$FABRIC_HOME/install-fabric.sh" https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
    chmod +x "$FABRIC_HOME/install-fabric.sh"
    (cd "$SAMPLES" && "$FABRIC_HOME/install-fabric.sh" --fabric-version "$FABRIC_VERSION" --ca-version "$CA_VERSION" binary docker)
    docker pull -q hyperledger/fabric-nodeenv:2.5 >/dev/null
}

# Copy the chaincode without node_modules/tests so the package stays small;
# the peer runs `npm install --production` when it builds the image.
stage_chaincode() {
    local out="$FABRIC_HOME/build/chaincode"
    rm -rf "$out" && mkdir -p "$out"
    cp -r "$ROOT/chaincode/index.js" "$ROOT/chaincode/lib" "$ROOT/chaincode/package.json" "$out/"
    [ -f "$ROOT/chaincode/package-lock.json" ] && cp "$ROOT/chaincode/package-lock.json" "$out/"
    echo "$out"
}

# CouchDB 3 creates its admin user a moment after it starts listening; a peer
# that connects in that window gets HTTP 401 and exits. Restart until stable.
wait_for_peers() {
    local peer tries
    for peer in peer0.org1.example.com peer0.org2.example.com; do
        for tries in 1 2 3 4 5 6; do
            sleep 5
            if [ "$(docker inspect -f '{{.State.Running}}' "$peer")" = true ]; then
                break
            fi
            echo "  $peer exited during start-up (CouchDB not ready yet), restarting..."
            docker start "$peer" >/dev/null
        done
    done
}

cmd_up() {
    download
    (cd "$TEST_NET" && ./network.sh up -ca -s couchdb -i "$FABRIC_VERSION" -cai "$CA_VERSION")
    wait_for_peers
    (cd "$TEST_NET" && ./network.sh createChannel -c "$CHANNEL")
    cmd_deploy
}

cmd_deploy() {
    local src
    src="$(stage_chaincode)"
    (cd "$TEST_NET" && ./network.sh deployCC -c "$CHANNEL" -ccn "$CC_NAME" -ccp "$src" -ccl javascript \
        -ccv "$CC_VERSION" -ccs "$CC_SEQUENCE" -ccep "$CC_POLICY" -cccg "$HERE/collections_config.json")
}

org_port() { [ "$1" = org1 ] && echo 7054 || echo 8054; }
org_msp() { [ "$1" = org1 ] && echo Org1MSP || echo Org2MSP; }

cmd_enroll() {
    local orgs="$TEST_NET/organizations"
    mkdir -p "$WALLET"
    chmod 700 "$WALLET"
    local creds="$WALLET/credentials.txt"
    : > "$creds"
    chmod 600 "$creds"

    grep -v '^\s*#' "$HERE/users.conf" | while read -r user org role hcid display; do
        [ -z "$user" ] && continue
        local port ca_cert ca_home secret dir
        port=$(org_port "$org")
        ca_cert="$orgs/fabric-ca/$org/ca-cert.pem"
        ca_home="$orgs/peerOrganizations/$org.example.com"
        secret=$(openssl rand -hex 16)
        dir="$WALLET/$user"
        rm -rf "$dir"

        FABRIC_CA_CLIENT_HOME="$ca_home" fabric-ca-client register --caname "ca-$org" \
            --id.name "$user" --id.secret "$secret" --id.type client \
            --id.attrs "hc.role=$role:ecert,hc.id=$hcid:ecert" \
            --tls.certfiles "$ca_cert" >/dev/null 2>&1 || {
                echo "  $user already registered with the CA; run './network.sh down && ./network.sh up' for a clean slate" >&2
                continue
            }
        FABRIC_CA_CLIENT_HOME="$ca_home" fabric-ca-client enroll \
            -u "https://$user:$secret@localhost:$port" --caname "ca-$org" -M "$dir/msp" \
            --enrollment.attrs "hc.role,hc.id" --tls.certfiles "$ca_cert" >/dev/null 2>&1

        # App-level login password (separate from the CA enrollment secret).
        local password
        password=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-12)
        cat > "$dir/identity.json" <<JSON
{
  "username": "$user",
  "mspId": "$(org_msp "$org")",
  "org": "$org",
  "role": "$role",
  "hcId": "$hcid",
  "displayName": "$display",
  "certPath": "msp/signcerts/cert.pem",
  "keyDir": "msp/keystore"
}
JSON
        node -e '
            const c = require("crypto");
            const salt = c.randomBytes(16);
            const hash = c.scryptSync(process.argv[1], salt, 32);
            require("fs").writeFileSync(process.argv[2], "scrypt$" + salt.toString("hex") + "$" + hash.toString("hex") + "\n", { mode: 0o600 });
        ' "$password" "$dir/password.hash"
        printf '%-8s %-10s %s\n' "$user" "$role" "$password" >> "$creds"
        echo "  enrolled $user ($role, $hcid, $(org_msp "$org"))"
    done
    echo
    echo "Demo login passwords (also saved in gateway/wallet/credentials.txt, git-ignored):"
    cat "$creds"
}

cmd_down() {
    if [ -d "$TEST_NET" ]; then
        (cd "$TEST_NET" && ./network.sh down)
    fi
    # Off-chain data and keys belong to this ledger; drop them with it.
    rm -rf "$WALLET" "$ROOT/gateway/data" "$FABRIC_HOME/build"
}

case "${1:-}" in
    up) cmd_up ;;
    deploy) cmd_deploy ;;
    enroll) cmd_enroll ;;
    down) cmd_down ;;
    *) sed -n '3,12p' "$0"; exit 1 ;;
esac
