#!/usr/bin/env python3
"""Smart-band simulator for the Composer REST API.

Posts a SendWearableData transaction every few seconds. Start a REST server
for the wearable's card first, e.g.:

    ./scripts/network.sh rest band 3001
    python3 wearable_simulator.py --url http://localhost:3001 \
        --patient <patientId> --device <wearableId>

If the REST server runs in multi-user mode, pass the access token with
--token or the WEARABLE_API_TOKEN environment variable. Nothing secret is
stored in this file.
"""
import argparse
import os
import random
import sys
import time

import requests

NS = "org.healthcare.com"


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default=os.environ.get("REST_URL", "http://localhost:3001"))
    p.add_argument("--patient", default=os.environ.get("PATIENT_ID"), required="PATIENT_ID" not in os.environ)
    p.add_argument("--device", default=os.environ.get("WEARABLE_ID"), required="WEARABLE_ID" not in os.environ)
    p.add_argument("--token", default=os.environ.get("WEARABLE_API_TOKEN"),
                   help="REST access token (multi-user mode only)")
    p.add_argument("--card", default="band@healthcare-network",
                   help="wallet card to select in multi-user mode")
    p.add_argument("--interval", type=float, default=3.0, help="seconds between readings")
    p.add_argument("--count", type=int, default=0, help="stop after N readings (0 = run forever)")
    return p.parse_args()


def main():
    args = parse_args()
    headers = {"X-Access-Token": args.token} if args.token else {}

    if args.token:
        r = requests.post(f"{args.url}/api/wallet/{requests.utils.quote(args.card)}/setDefault", headers=headers)
        if r.status_code != 204:
            sys.exit(f"** Error authenticating wearable: {r.status_code} {r.text}")
        print("** Wearable was successfully authenticated **")

    pedometer, calories, attempts = 0, 0, 0
    while args.count == 0 or attempts < args.count:
        attempts += 1
        data = {
            "$class": f"{NS}.SendWearableData",
            "pedometer": pedometer,
            "calories": calories,
            "heartbeat": random.randint(50, 180),
            "owner": f"resource:{NS}.Patient#{args.patient}",
            "device": f"resource:{NS}.Wearable#{args.device}",
        }
        r = requests.post(f"{args.url}/api/SendWearableData", json=data, headers=headers)
        if r.status_code == 200:
            print(f"** Sent heartbeat={data['heartbeat']} pedometer={pedometer} calories={calories} "
                  f"(tx {r.json().get('transactionId', '?')[:12]})")
            pedometer += 25
            calories += 1
        else:
            try:
                message = r.json()["error"]["message"]
            except (ValueError, KeyError):
                message = r.text
            print(f"** Rejected ({r.status_code}): {message.strip().splitlines()[-1][:300]}")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
