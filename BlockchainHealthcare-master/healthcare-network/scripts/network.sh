#!/usr/bin/env bash
#
# Run the Composer 0.20 business network on a local Fabric 1.2 network.
# Everything runs in Docker: Fabric 1.2 containers plus a pinned Node 8
# image with composer-cli / composer-rest-server / composer-playground.
#
#   ./scripts/network.sh up          start Fabric 1.2 (orderer, peer, CA, CouchDB) and create the channel
#   ./scripts/network.sh deploy      build the .bna, install + start it, import the admin card
#   ./scripts/network.sh seed        create demo participants and issue an identity card for each
#   ./scripts/network.sh rest [card] [port]   start a REST API for a card (default admin, port 3000)
#   ./scripts/network.sh playground  start Composer Playground on http://localhost:8080
#   ./scripts/network.sh cli <args>  run any composer CLI command, e.g. cli card list
#   ./scripts/network.sh down        remove all containers (ledger data is lost)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FABRIC_DIR="$ROOT/fabric-tools/fabric-scripts/hlfv12/composer"
COMPOSE=(docker compose -p composer -f "$FABRIC_DIR/docker-compose.yml")
TOOLS_IMAGE="healthcare/composer-tools:0.20.9"
NETWORK_NAME="healthcare-network"
CARD_HOME="$ROOT/.composer-home"   # card store lives here (git-ignored, contains secrets)

tools_image() {
    if ! docker image inspect "$TOOLS_IMAGE" >/dev/null 2>&1; then
        docker build -t "$TOOLS_IMAGE" -f "$ROOT/docker/composer-tools.Dockerfile" "$ROOT/docker"
    fi
}

# Run a command in the tools container on the Fabric docker network.
tools() {
    tools_image
    mkdir -p "$CARD_HOME"
    docker run --rm -i --network composer_default \
        -u "$(id -u):$(id -g)" -e HOME=/home/composer \
        -v "$CARD_HOME":/home/composer -v "$ROOT":/network -w /network \
        "$TOOLS_IMAGE" "$@"
}

id_of() { printf '%s' "$1" | md5sum | cut -c1-32; }

cmd_up() {
    "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
    "${COMPOSE[@]}" up -d
    echo "Waiting ${FABRIC_START_TIMEOUT:-15}s for Fabric to start..."
    sleep "${FABRIC_START_TIMEOUT:-15}"
    docker exec peer0.org1.example.com peer channel create -o orderer.example.com:7050 \
        -c composerchannel -f /etc/hyperledger/configtx/composer-channel.tx
    docker exec -e "CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/msp/users/Admin@org1.example.com/msp" \
        peer0.org1.example.com peer channel join -b composerchannel.block
    echo "Fabric 1.2 is up; channel 'composerchannel' created."
}

cmd_deploy() {
    local msp="fabric-tools/fabric-scripts/hlfv12/composer/crypto-config/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
    local version
    version=$(node -p "require('$ROOT/package.json').version" 2>/dev/null || grep -m1 '"version"' "$ROOT/package.json" | cut -d'"' -f4)
    mkdir -p "$ROOT/dist"
    tools sh -ec "
        composer card delete -c PeerAdmin@hlfv1 >/dev/null 2>&1 || true
        composer card delete -c admin@$NETWORK_NAME >/dev/null 2>&1 || true
        composer card create -p connection/connection.json -u PeerAdmin \
            -c $msp/signcerts/Admin@org1.example.com-cert.pem \
            -k \$(ls $msp/keystore/*_sk) -r PeerAdmin -r ChannelAdmin -f /tmp/PeerAdmin.card
        composer card import -f /tmp/PeerAdmin.card -c PeerAdmin@hlfv1
        composer archive create -t dir -n . -a dist/$NETWORK_NAME@$version.bna
        composer network install -c PeerAdmin@hlfv1 -a dist/$NETWORK_NAME@$version.bna
        composer network start -c PeerAdmin@hlfv1 -n $NETWORK_NAME -V $version \
            -A admin -S adminpw -f /tmp/admin.card
        composer card import -f /tmp/admin.card -c admin@$NETWORK_NAME
        composer network ping -c admin@$NETWORK_NAME
    "
}

cmd_seed() {
    local ns=org.healthcare.com
    local alice drA labA trainer band
    alice=$(id_of patient-alice); drA=$(id_of clinician-a); labA=$(id_of lab-a)
    trainer=$(id_of trainer); band=$(id_of band-alice)
    tools sh -ec "
        add() { composer participant add -c admin@$NETWORK_NAME -d \"\$1\"; }
        issue() {
            composer card delete -c \$2@$NETWORK_NAME >/dev/null 2>&1 || true
            composer identity issue -c admin@$NETWORK_NAME -u \$2 -a \"resource:\$1\" -f /tmp/\$2.card
            composer card import -f /tmp/\$2.card -c \$2@$NETWORK_NAME
        }
        add '{\"\$class\":\"$ns.Patient\",\"patientId\":\"$alice\"}'
        add '{\"\$class\":\"$ns.Clinician\",\"clinicianId\":\"$drA\"}'
        add '{\"\$class\":\"$ns.Lab\",\"labId\":\"$labA\"}'
        add '{\"\$class\":\"$ns.PersonalTrainer\",\"trainerId\":\"$trainer\"}'
        add '{\"\$class\":\"$ns.Wearable\",\"wearableId\":\"$band\",\"name\":\"Alice smart band\",\"owner\":\"resource:$ns.Patient#$alice\"}'
        issue $ns.Patient#$alice alice
        issue $ns.Clinician#$drA drA
        issue $ns.Lab#$labA labA
        issue $ns.PersonalTrainer#$trainer trainer
        issue $ns.Wearable#$band band
        composer card list
    "
    cat <<INFO

Demo participants
  Patient alice        $alice   card alice@$NETWORK_NAME
  Clinician drA        $drA   card drA@$NETWORK_NAME
  Lab labA             $labA   card labA@$NETWORK_NAME
  Trainer              $trainer   card trainer@$NETWORK_NAME
  Wearable band        $band   card band@$NETWORK_NAME (paired with alice)
INFO
}

cmd_rest() {
    local card="${1:-admin}@$NETWORK_NAME" port="${2:-3000}"
    tools_image
    echo "REST API for $card on http://localhost:$port/explorer"
    docker run --rm $([ -t 0 ] && echo -it || echo -i) --name "composer-rest-$port" --network composer_default -p "$port:3000" \
        -u "$(id -u):$(id -g)" -e HOME=/home/composer -v "$CARD_HOME":/home/composer \
        "$TOOLS_IMAGE" composer-rest-server -c "$card" -n never -w true -p 3000
}

cmd_playground() {
    tools_image
    echo "Composer Playground on http://localhost:8080"
    docker run --rm $([ -t 0 ] && echo -it || echo -i) --name composer-playground --network composer_default -p 8080:8080 \
        -u "$(id -u):$(id -g)" -e HOME=/home/composer -v "$CARD_HOME":/home/composer \
        "$TOOLS_IMAGE" composer-playground -p 8080
}

cmd_down() {
    "${COMPOSE[@]}" down --remove-orphans
    # Chaincode containers/images are created by the peer, not by compose.
    docker ps -aq --filter "name=dev-peer0.org1.example.com" | xargs -r docker rm -f
    docker images -q "dev-peer0.org1.example.com-*" | xargs -r docker rmi -f
    rm -rf "$CARD_HOME"
}

case "${1:-}" in
    up) cmd_up ;;
    deploy) cmd_deploy ;;
    seed) cmd_seed ;;
    rest) shift; cmd_rest "$@" ;;
    playground) cmd_playground ;;
    cli) shift; tools composer "$@" ;;
    down) cmd_down ;;
    *) sed -n '3,15p' "$0"; exit 1 ;;
esac
