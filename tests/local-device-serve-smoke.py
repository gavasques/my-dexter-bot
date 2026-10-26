#!/usr/bin/env python3
"""One isolated serve process smoke; synthetic password stays in inherited FIFO memory only."""
import hashlib
import json
import os
import select
import signal
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[1]
NODE = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
CLI = WORKSPACE / "packages/cli/dist/index.js"

def request(url, suffix, method="GET", data=None):
    req = urllib.request.Request(url + suffix, method=method, data=None if data is None else json.dumps(data).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.load(response)

def ready(child):
    deadline = time.monotonic() + 15
    text = ""
    while time.monotonic() < deadline:
        if child.poll() is not None:
            error = child.stderr.read().decode(errors="replace")
            code = error.split(":", 1)[0] if ":" in error else "unavailable"
            if not code.replace("_", "").isalpha() or len(code) > 40:
                code = "unavailable"
            raise RuntimeError("synthetic serve exited before ready: " + code)
        if select.select([child.stdout], [], [], 0.1)[0]:
            byte = os.read(child.stdout.fileno(), 4096)
            if not byte:
                continue
            text += byte.decode()
            if len(text) > 32768:
                raise RuntimeError("oversize serve output")
            try:
                value = json.loads(text)
                assert value["status"] == "ready"
                return value, text
            except json.JSONDecodeError:
                pass
    raise RuntimeError("synthetic serve ready deadline")

with tempfile.TemporaryDirectory(prefix="dexter-serve-sealed-") as directory:
    root = Path(directory).resolve()
    env = {"PATH": str(Path(NODE).parent) + ":/usr/bin:/bin", "HOME": str(root), "TMPDIR": str(root), "NODE_NO_WARNINGS": "1"}
    password = os.urandom(32)
    data = root / "canonical"
    file = root / "keys/host.sealed"
    # Incomplete explicit custody flags must refuse before initializing any canonical data.
    denied = subprocess.run([NODE, str(CLI), "serve", "--data-dir", str(data), "--local-device-custody-file", str(file)],
                            stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=10)
    assert denied.returncode != 0 and not data.exists() and not file.exists()
    fingerprints = []
    ciphertext = None
    for action in ("create", "unlock"):
        args = [NODE, str(CLI), "serve", "--data-dir", str(data), "--port", "0", "--device-port", "0",
                "--local-device-custody-file", str(file), "--local-device-custody-action", action,
                "--local-device-password-fd", "0"]
        child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        try:
            child.stdin.write(password)
            child.stdin.close()
            state, printed = ready(child)
            assert state["engineExecution"] == "disabled" and state["deviceTurnTools"] == "disabled"
            assert state["deviceChannel"]["status"] == "listening"
            assert state["deviceChannel"]["url"].startswith("https://127.0.0.1:")
            setup = request(state["url"], "/v1/local-mac-agent/setup", "POST", {})
            assert setup["schema"] == "dexter.local-mac-agent-setup/1"
            assert setup["offer"]["hostUrl"] == state["deviceChannel"]["url"]
            assert len(setup["offer"]["code"]) > 1 and len(setup["offer"]["code"]) == 43
            assert setup["offer"]["code"] not in printed and "PRIVATE KEY" not in printed and "BEGIN CERTIFICATE" not in printed
            claims = request(state["url"], "/v1/local-mac-agent/claims")
            assert claims == {"claims": []}
            fingerprints.append((setup["installationId"], setup["offer"]["hostFingerprint"]))
            sealed = file.read_bytes()
            assert sealed[:8] == b"DXSEAL01" and b"PRIVATE KEY" not in sealed
            current = hashlib.sha256(sealed).hexdigest()
            if ciphertext is None:
                ciphertext = current
            else:
                assert ciphertext == current
            child.send_signal(signal.SIGTERM)
            child.wait(timeout=10)
            assert child.returncode == 0
            assert b"PRIVATE KEY" not in child.stderr.read()
        finally:
            if child.poll() is None:
                child.send_signal(signal.SIGTERM)
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
    assert fingerprints[0] == fingerprints[1]
    # Unlock absent installation must not initialize it (existing-only contract).
    absent = root / "absent"
    denied = subprocess.run([NODE, str(CLI), "serve", "--data-dir", str(absent), "--local-device-custody-file", str(file),
                             "--local-device-custody-action", "unlock", "--local-device-password-fd", "0"],
                            input=password, capture_output=True, env=env, timeout=10)
    assert denied.returncode != 0 and not absent.exists()
    print(json.dumps({"status": "passed", "createUnlock": 2, "tlsChannel": "loopback-listening", "setupRoute": "observed",
                      "stableIdentityPinCiphertext": True, "explicitFlagsRefusedBeforeDisk": True,
                      "unlockExistingOnly": True, "enginesTools": "disabled", "cleanShutdowns": 2}))
