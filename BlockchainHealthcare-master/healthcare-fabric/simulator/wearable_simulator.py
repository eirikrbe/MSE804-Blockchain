#!/usr/bin/env python3
"""Smart-band simulator for the Fabric 2.5 gateway.

Takes a reading every --interval seconds (like the original project), but
instead of one blockchain transaction per reading it sends a *batch* every
--batch-size readings. The band computes the Merkle root itself; the gateway
re-computes it, stores the raw readings encrypted off-chain and records one
transaction with the root and summary statistics.

    python3 wearable_simulator.py --user band --batch-size 20 --interval 3

The password is read from $WEARABLE_PASSWORD or gateway/wallet/credentials.txt
(written by `network/network.sh enroll`). No secret is stored in this file.
"""
import argparse
import hashlib
import json
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

CREDENTIALS = Path(__file__).resolve().parent.parent / "gateway" / "wallet" / "credentials.txt"


# --- Merkle tree: must match gateway/src/merkle.js -------------------------

def _h(*parts: bytes) -> bytes:
    return hashlib.sha256(b"".join(parts)).digest()


def _leaf(reading: dict) -> bytes:
    canonical = json.dumps(reading, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return _h(b"\x00", canonical.encode())


def merkle_root(readings: list) -> str:
    level = [_leaf(r) for r in readings]
    while len(level) > 1:
        level = [_h(b"\x01", level[i], level[i + 1]) if i + 1 < len(level) else level[i]
                 for i in range(0, len(level), 2)]
    return level[0].hex()


# ---------------------------------------------------------------------------

def password_for(user: str) -> str:
    if os.environ.get("WEARABLE_PASSWORD"):
        return os.environ["WEARABLE_PASSWORD"]
    if CREDENTIALS.exists():
        for line in CREDENTIALS.read_text().splitlines():
            parts = line.split()
            if parts and parts[0] == user:
                return parts[-1]
    sys.exit(f"No password for {user}: set WEARABLE_PASSWORD or run network/network.sh enroll")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default=os.environ.get("GATEWAY_URL", "http://localhost:3000"))
    p.add_argument("--user", default="band", help="gateway user of the wearable (default: band)")
    p.add_argument("--interval", type=float, default=3.0, help="seconds between readings")
    p.add_argument("--batch-size", type=int, default=20, help="readings per blockchain transaction")
    p.add_argument("--batches", type=int, default=0, help="stop after N batches (0 = forever)")
    args = p.parse_args()

    r = requests.post(f"{args.url}/api/login", json={"username": args.user, "password": password_for(args.user)})
    if r.status_code != 200:
        sys.exit(f"Login failed: {r.status_code} {r.text}")
    headers = {"Authorization": f"Bearer {r.json()['token']}"}
    print(f"** {args.user} logged in; one transaction every {args.batch_size} readings "
          f"(~{args.batch_size * args.interval:.0f}s)")

    steps, calories, sent = 0, 0, 0
    buffer = []
    while args.batches == 0 or sent < args.batches:
        steps += random.randint(0, 40)
        calories += random.randint(0, 2)
        buffer.append({
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "heartRate": random.randint(55, 160),
            "steps": steps,
            "calories": calories,
        })
        if len(buffer) >= args.batch_size:
            root = merkle_root(buffer)
            res = requests.post(f"{args.url}/api/wearables/batch", headers=headers,
                                json={"readings": buffer, "merkleRoot": root})
            if res.status_code == 201:
                b = res.json()
                s = b["stats"]
                print(f"** batch {b['batchId'][:12]}: {b['count']} readings, HR {s['heartRateMin']}-{s['heartRateMax']} "
                      f"(avg {s['heartRateAvg']}), {s['steps']} steps, root {root[:16]}...")
                sent += 1
            else:
                print(f"** batch rejected ({res.status_code}): {res.json().get('error', res.text)}")
            buffer = []
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
