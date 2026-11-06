#!/usr/bin/env python3
"""InfiniteTalk test-round controller. Creates ONE Pod, arms the independent
guardian (guardian.py) BEFORE any billable work, runs install.sh + run_test.sh
over SSH, retrieves the result, and stops the Pod — never reporting success
until the stop is independently confirmed via the Runpod API.

Separate identity from workers/ltx-pod: pod names are "conveyer-it-*", never
"conveyer-ltx-*". Never reuses a previous round's approvalId/podId.

RUNPOD_API_KEY / HF_TOKEN are read from .env.local and passed only where
needed (HF_TOKEN into the Pod's own env, for huggingface-cli); neither is ever
printed or logged.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SESSION_DIR = ROOT / "session"
RESULTS_DIR = ROOT / "results"
SSH_KEY = ROOT / "ssh" / "conveyer_it_round"
GUARDIAN = ROOT / "guardian.py"
INSTALL_SH = ROOT / "install.sh"
RUN_TEST_SH = ROOT / "run_test.sh"
TEST_INPUTS = Path(
    "/Users/guilhermearaki/Documents/Codex/2026-10-05/continue-o-projeto-conveyer-runpod-ltx"
    "/outputs/infinitetalk-teste"
)

BUDGET_USD = 2
MAX_MINUTES = 90
GUARD_STOP_MINUTES = 65
APPROVED_GPU_RATE = 0.89  # ceiling; observed quote was lower, this is the hard cap
GPU_TYPE = "NVIDIA GeForce RTX 4090"
DATA_CENTERS = ["EU-RO-1", "EUR-NO-1"]
IMAGE_NAME = "runpod/base:1.4.0-cuda1281-ubuntu2204"


def env_value(key: str) -> str:
    text = (ROOT.parent.parent / ".env.local").read_text()
    m = re.search(rf"^{key}=(.*)$", text, re.MULTILINE)
    if not m:
        raise RuntimeError(f"{key} not found in .env.local")
    return m.group(1).strip().strip('"').strip("'")


def rest(method: str, path: str, api_key: str, body: dict | None = None) -> dict:
    url = f"https://rest.runpod.io/v1{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, method=method, data=data, headers={
        "Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
        "User-Agent": "Conveyer-InfiniteTalk/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        # Round 9 (2026-10-10): three consecutive pod-create 500s with no diagnostic beyond
        # "HTTP Error 500" — the response body (Runpod's actual error message) was never read.
        # Print it before re-raising so a repeat failure is diagnosable instead of a bare code.
        detail = error.read().decode(errors="replace")
        print(f"=== HTTPError {error.code} body ===\n{detail}")
        raise


def create_pod(api_key: str, hf_token: str, name: str) -> dict:
    payload = {
        "name": name,
        "imageName": IMAGE_NAME,
        "cloudType": "SECURE",
        "gpuTypeIds": [GPU_TYPE],
        "gpuCount": 1,
        "containerDiskInGb": 40,
        "volumeInGb": 150,
        "volumeMountPath": "/workspace",
        "ports": ["22/tcp"],
        "dataCenterIds": DATA_CENTERS,
        "interruptible": False,
        "allowedCudaVersions": ["12.1", "12.2", "12.3", "12.4", "12.5", "12.6", "12.7", "12.8", "12.9"],
        "env": {"HF_TOKEN": hf_token},
    }
    print("=== Pod create payload (HF_TOKEN redacted) ===")
    redacted = {**payload, "env": {"HF_TOKEN": "<redacted>"}}
    print(json.dumps(redacted, indent=2))
    return rest("POST", "/pods", api_key, payload)


def wait_running(api_key: str, pod_id: str, timeout_s: int = 300) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        pod = rest("GET", f"/pods/{pod_id}", api_key)
        status = pod.get("desiredStatus") or pod.get("status")
        ip = pod.get("publicIp")
        ports = pod.get("portMappings") or {}
        print(f"    pod status={status} publicIp={ip} ports={ports}")
        if status == "RUNNING" and ip and "22" in ports:
            return pod
        time.sleep(10)
    raise RuntimeError("Pod did not reach RUNNING with SSH mapped within timeout")


def wait_armed(session_dir: Path, approval_id: str, pod_id: str, timeout_s: int = 60) -> None:
    deadline = time.time() + timeout_s
    armed_path = session_dir / "armed.json"
    while time.time() < deadline:
        if armed_path.exists():
            try:
                armed = json.loads(armed_path.read_text())
            except json.JSONDecodeError:
                armed = {}
            if (armed.get("approvalId") == approval_id and armed.get("podId") == pod_id
                    and armed.get("state") == "armed"
                    and time.time() * 1000 - armed.get("observedAt", 0) < 30_000):
                print("=== Guardian armed and confirmed ===")
                return
        time.sleep(1)
    raise RuntimeError("Guardian did not confirm armed in time — aborting before any billable work")


# Incident 2026-10-10: a silent (--quiet) pip step produced minutes with zero bytes on the
# wire, and some network path between here and the Pod dropped the connection as "idle"
# without either end noticing — "Read from remote host: Operation timed out". Keepalive
# packets are real SSH protocol traffic, so a NAT/proxy counting bytes (not just TCP state)
# no longer sees silence. ServerAliveCountMax=3 @ 15s means a genuinely dead link is detected
# within ~45s instead of hanging for the rest of the round.
SSH_OPTS = [
    "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
]


def ssh_run(ip: str, port: str, remote_cmd: str) -> int:
    cmd = ["ssh", "-i", str(SSH_KEY), "-p", str(port), *SSH_OPTS, f"root@{ip}", remote_cmd]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        print(line, end="")
    return proc.wait()


def scp_to_remote(ip: str, port: str, local: Path, remote: str) -> None:
    subprocess.run(["scp", "-i", str(SSH_KEY), "-P", str(port), *SSH_OPTS, str(local), f"root@{ip}:{remote}"], check=True)


def scp_from_remote(ip: str, port: str, remote: str, local: Path) -> None:
    subprocess.run(["scp", "-i", str(SSH_KEY), "-P", str(port), *SSH_OPTS, f"root@{ip}:{remote}", str(local)], check=True)


def request_stop(api_key: str, pod_id: str, session_dir: Path) -> None:
    (session_dir / "STOP_NOW").write_text("stop")
    # Incident 2026-10-10: the Pod came back from creation with "locked": true (the
    # PodCreateInput schema's own documented default is false — this was never requested),
    # and a locked Pod silently rejects /stop. Unlock is idempotent and harmless when the
    # Pod was never locked, so it runs unconditionally, every time, before every stop
    # attempt — never assume this round's Pod won't repeat it.
    try:
        rest("PATCH", f"/pods/{pod_id}", api_key, {"locked": False})
    except Exception as e:  # noqa: BLE001
        print(f"    (unlock call raised {type(e).__name__} — stop may still fail if it's actually locked)")
    try:
        rest("POST", f"/pods/{pod_id}/stop", api_key)
    except Exception as e:  # noqa: BLE001 — best-effort direct stop; guardian is the real backstop
        print(f"    (direct stop call raised {type(e).__name__}, guardian will still stop it)")


def wait_stopped(api_key: str, pod_id: str, timeout_s: int = 120) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        pod = rest("GET", f"/pods/{pod_id}", api_key)
        status = pod.get("desiredStatus") or pod.get("status")
        print(f"    stop-wait status={status}")
        if status in ("EXITED", "TERMINATED"):
            return True
        time.sleep(5)
    return False


def main() -> int:
    api_key = env_value("RUNPOD_API_KEY")
    hf_token = env_value("HF_TOKEN")
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    if (SESSION_DIR / "session.json").exists() or (SESSION_DIR / "STOP_NOW").exists():
        print("A session already exists in", SESSION_DIR, "— refusing to start a second round on top of it.")
        return 1

    approval_id = f"it-{uuid.uuid4().hex[:16]}"
    pod_name = f"conveyer-it-{uuid.uuid4().hex[:10]}"
    print(f"=== Round identity: approvalId={approval_id} podName={pod_name} ===")

    # Set before the try so ANY failure from this point on — including the Pod
    # existing but never reaching RUNNING — still triggers the stop in finally.
    # A pod_id assigned here means billing has started; nothing after this line
    # may exit without attempting a stop.
    pod_id: str | None = None
    guardian_proc: subprocess.Popen | None = None

    try:
        print("=== Creating Pod (THIS IS THE FIRST BILLABLE CALL) ===")
        created = create_pod(api_key, hf_token, pod_name)
        pod_id = created.get("id")
        if not pod_id:
            print("Pod creation did not return an id:", created)
            return 1
        print(f"=== Pod created: {pod_id} ===")

        pod = wait_running(api_key, pod_id)
        ip = pod["publicIp"]
        ssh_port = pod["portMappings"]["22"]
        print(f"=== Pod RUNNING: {ip}:{ssh_port} ===")

        started_at = time.time() * 1000
        lease = {
            "approvalId": approval_id,
            "podId": pod_id,
            "podName": pod_name,
            "startedAt": started_at,
            "deadline": started_at + GUARD_STOP_MINUTES * 60_000,
            "budgetUsd": BUDGET_USD,
            "approvedGpuRate": APPROVED_GPU_RATE,
        }
        lease_path = SESSION_DIR / "lease.json"
        lease_path.write_text(json.dumps(lease))
        lease_path.chmod(0o600)

        print("=== Starting independent guardian (detached) ===")
        guardian_env = {**os.environ, "RUNPOD_API_KEY": api_key}
        guardian_proc = subprocess.Popen(
            [sys.executable, str(GUARDIAN), "--session-dir", str(SESSION_DIR), "--lease", str(lease_path)],
            env=guardian_env, start_new_session=True,
            stdout=open(SESSION_DIR / "guardian.log", "w"), stderr=subprocess.STDOUT,
        )
        print(f"=== Guardian PID {guardian_proc.pid} ===")

        wait_armed(SESSION_DIR, approval_id, pod_id)

        print("=== Uploading install.sh / run_test.sh ===")
        ssh_run(ip, ssh_port, "mkdir -p /workspace/infinitetalk")
        scp_to_remote(ip, ssh_port, INSTALL_SH, "/workspace/infinitetalk/install.sh")
        scp_to_remote(ip, ssh_port, RUN_TEST_SH, "/workspace/infinitetalk/run_test.sh")
        ssh_run(ip, ssh_port, "mkdir -p /workspace/infinitetalk/test-inputs")
        for fname in ("finn-referencia.jpg", "narracao-teste.wav", "entrada-infinitetalk.json"):
            scp_to_remote(ip, ssh_port, TEST_INPUTS / fname, f"/workspace/infinitetalk/test-inputs/{fname}")

        print("=== Running install.sh over SSH (live output below) ===")
        rc = ssh_run(ip, ssh_port, "chmod +x /workspace/infinitetalk/*.sh && "
                                    "INFINITETALK_WORK_DIR=/workspace/infinitetalk bash /workspace/infinitetalk/install.sh")
        if rc != 0:
            raise RuntimeError(f"install.sh exited {rc}")

        print("=== Running run_test.sh over SSH (live output below) ===")
        rc = ssh_run(ip, ssh_port,
                     "INFINITETALK_WORK_DIR=/workspace/infinitetalk "
                     "INFINITETALK_TEST_INPUTS=/workspace/infinitetalk/test-inputs "
                     "bash /workspace/infinitetalk/run_test.sh")
        if rc != 0:
            raise RuntimeError(f"run_test.sh exited {rc}")

        print("=== Retrieving result ===")
        ssh_run(ip, ssh_port, "ls -la /workspace/infinitetalk/repo/infinitetalk_res_test*")
        scp_from_remote(ip, ssh_port, "/workspace/infinitetalk/repo/infinitetalk_res_test.mp4",
                         RESULTS_DIR / "infinitetalk_res_test.mp4")
        print(f"=== Result saved to {RESULTS_DIR / 'infinitetalk_res_test.mp4'} ===")

    finally:
        # Incident 2026-10-10: this block used to SIGTERM the guardian unconditionally,
        # including the one time it mattered most — when stop wasn't confirmed. That is
        # backwards: the guardian's entire purpose is to keep trying when THIS process
        # gives up or dies. It is now only ever terminated after an independently
        # confirmed stop; any other exit path (including this script crashing outright)
        # leaves it running, retrying on its own 5s loop, exactly as designed.
        stopped = False
        if pod_id is not None:
            print("=== Stopping Pod (unlock + stop, retried) ===")
            for attempt in range(3):
                request_stop(api_key, pod_id, SESSION_DIR)
                stopped = wait_stopped(api_key, pod_id)
                print(f"=== Pod stop confirmed via API (attempt {attempt + 1}/3): {stopped} ===")
                if stopped:
                    break
            if not stopped:
                print("!!! STOP NOT CONFIRMED after 3 attempts — check the Runpod dashboard NOW. "
                      "The guardian process is DELIBERATELY still running and will keep retrying "
                      "on its own — do not kill it manually unless you have confirmed the Pod is stopped.")
        if guardian_proc is not None and stopped:
            try:
                os.kill(guardian_proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
