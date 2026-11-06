"""Independent stop-only guardian. Does not create, resume, delete or resize Pods.

Run only after explicit approval of the paid round. RUNPOD_API_KEY is inherited
in the environment; credentials are never written to the lease or logs.
"""
import argparse
import json
import math
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


def api(pod_id, stop=False):
    key = os.environ.get("RUNPOD_API_KEY", "").strip()
    if not key:
        raise RuntimeError("Credential absent")
    url = ("https://rest.runpod.io/v1/pods/" + pod_id + "/stop" if stop
           else "https://api.runpod.io/v2/pods/" + pod_id)
    request = urllib.request.Request(url, method="POST" if stop else "GET", headers={
        "Authorization": "Bearer " + key, "User-Agent": "Conveyer-LTX/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=15) as response:
        data = response.read()
        return json.loads(data) if data else {}


def observe(lease, pod, now, stop_requested):
    if pod.get("name") != lease["podName"]:
        raise RuntimeError("Ownership mismatch")
    if pod.get("status") in ("EXITED", "TERMINATED"):
        return "stopped"
    try:
        price = float(pod.get("cost", 0))
    except (ValueError, TypeError):
        return "stop"
    if stop_requested or now >= lease["deadline"] or not math.isfinite(price) or price <= 0 or price > min(lease.get("approvedGpuRate", 0.72), 0.99):
        return "stop"
    return "armed"


def persist(target, data):
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(data))
    temporary.chmod(0o600)
    temporary.replace(target)


def run(directory, lease):
    now = time.time() * 1000
    anchor_wall, anchor_monotonic = now, time.monotonic()
    if lease.get("budgetUsd") != 2 or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", lease.get("approvalId", "")):
        raise RuntimeError("Invalid approved budget or identity")
    if not (now - 65 * 60_000 <= lease["startedAt"] <= now < lease["deadline"] <= lease["startedAt"] + 65 * 60_000):
        raise RuntimeError("Expired or excessive deadline")
    if not re.fullmatch(r"[a-z0-9]{8,40}", lease["podId"]) or not re.fullmatch(r"conveyer-ltx-[A-Za-z0-9-]+", lease["podName"]):
        raise RuntimeError("Invalid test Pod")
    directory.mkdir(parents=True, exist_ok=True)
    lease["guardianPid"] = os.getpid()
    # Never overwrite an earlier lease/stop signal or extend the paid-round clock.
    if (directory / "STOP_NOW").exists():
        raise RuntimeError("Existing stop signal")
    with (directory / "session.json").open("x") as output:
        json.dump(lease, output)
    (directory / "session.json").chmod(0o600)
    sleeper = subprocess.Popen(["/usr/bin/caffeinate", "-i", "-s", "-w", str(os.getpid())],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) if os.path.exists("/usr/bin/caffeinate") else None
    verified_owner = False
    try:
        while True:
            now = max(time.time() * 1000, anchor_wall + (time.monotonic() - anchor_monotonic) * 1000)
            requested = (directory / "STOP_NOW").exists()
            try:
                pod = api(lease["podId"])
                state = observe(lease, pod, now, requested)
                verified_owner = True
                persist(directory / "armed.json", {"approvalId": lease["approvalId"], "podId": lease["podId"],
                        "pid": os.getpid(), "deadline": lease["deadline"], "observedAt": now,
                        "state": "stopped" if state == "stopped" else "armed" if state == "armed" else "stopping"})
                if state == "stopped":
                    return
                if state == "stop":
                    api(lease["podId"], stop=True)
            except Exception as error:
                # Retry the idempotent STOP even if observation fails after ownership was established.
                if verified_owner and (requested or now >= lease["deadline"]):
                    try:
                        api(lease["podId"], stop=True)
                    except Exception:
                        pass
                print(json.dumps({"event": "guardian_retry", "error_type": type(error).__name__}), flush=True)
            time.sleep(5)
    finally:
        if sleeper:
            sleeper.terminate()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-dir", required=True)
    parser.add_argument("--lease", required=True, help="Preapproved identity and absolute deadline; no credentials")
    args = parser.parse_args()
    run(Path(args.session_dir), json.loads(Path(args.lease).read_text()))
