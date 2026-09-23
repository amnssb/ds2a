#!/usr/bin/env python3
"""Offline-friendly deploy: local node base image + compose build."""
import sys
import time
import paramiko

HOST = "166.1.232.147"
USER = "root"
PASS = "Aa11012345"
REPO_DIR = "/root/ds2a"
BASE_IMAGE = "ds-node-base:20"


def run(c, cmd, timeout=300, stream=False):
    print(f"\n$ {cmd}", flush=True)
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    if stream:
        while True:
            line = stdout.readline()
            if not line and stdout.channel.exit_status_ready():
                break
            if line:
                print(line, end="", flush=True)
        err = stderr.read().decode(errors="replace")
        rc = stdout.channel.recv_exit_status()
        if err.strip():
            print(err, end="", flush=True)
        print(f"[exit {rc}]", flush=True)
        return rc, err
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    rc = stdout.channel.recv_exit_status()
    print(out, end="")
    if err.strip():
        print(f"STDERR:\n{err}", end="")
    print(f"[exit {rc}]")
    return rc, out + err


def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, port=22, username=USER, password=PASS, timeout=15, allow_agent=False, look_for_keys=False)
    print("SSH connected")

    # preserve current image as offline base if present
    BASE = BASE_IMAGE
    rc, out = run(c, f"docker image inspect {BASE_IMAGE} >/dev/null 2>&1 && echo HAS_BASE || echo NO_BASE")
    if "HAS_BASE" not in out:
        rc, out = run(c, "docker image inspect ds-gateway:latest >/dev/null 2>&1 && echo HAS_GW || echo NO_GW")
        if "HAS_GW" in out:
            run(c, f"docker tag ds-gateway:latest {BASE_IMAGE}")
            print(f"tagged ds-gateway:latest -> {BASE_IMAGE}")
            BASE = BASE_IMAGE
        else:
            print("WARNING: no ds-gateway image to use as base; will try docker.io")
            BASE = "node:20-alpine"

    # pull latest code
    run(c, f"cd {REPO_DIR} && git fetch origin && git reset --hard origin/main && git log --oneline -3", timeout=120)

    # ensure data dirs exist and are writable by container node (uid 1000)
    run(c, f"mkdir -p {REPO_DIR}/data {REPO_DIR}/logs && chown -R 1000:1000 {REPO_DIR}/data {REPO_DIR}/logs && chmod -R 775 {REPO_DIR}/data {REPO_DIR}/logs")

    # ensure .env has NODE_IMAGE
    run(
        c,
        f"cd {REPO_DIR} && grep -q '^NODE_IMAGE=' .env 2>/dev/null || echo 'NODE_IMAGE={BASE}' >> .env; "
        f"grep '^NODE_IMAGE=' .env || true",
    )

    # build offline base
    print("\n=== docker compose build (local base) ===")
    rc, _ = run(
        c,
        f"cd {REPO_DIR} && NODE_IMAGE={BASE} docker compose build --build-arg NODE_IMAGE={BASE} 2>&1",
        timeout=600,
        stream=True,
    )
    if rc != 0:
        print("compose build failed, trying plain docker build")
        rc, _ = run(
            c,
            f"cd {REPO_DIR} && docker build --build-arg NODE_IMAGE={BASE} -t ds-gateway:latest . 2>&1",
            timeout=600,
            stream=True,
        )
        if rc != 0:
            print("BUILD_FAILED")
            c.close()
            sys.exit(1)

    # rebuild after fix: re-tag base first if image was overwritten last failed attempt
    run(c, f"mkdir -p {REPO_DIR}/data {REPO_DIR}/logs && chown -R 1000:1000 {REPO_DIR}/data {REPO_DIR}/logs")
    run(c, f"cd {REPO_DIR} && docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --force-recreate 2>&1", timeout=180, stream=True)
    time.sleep(6)

    run(c, "docker ps --filter name=ds-gateway --format '{{.Names}} {{.Status}} {{.Ports}}'")
    run(c, "curl -fsS http://127.0.0.1:19728/health; echo")
    run(c, "docker logs ds-gateway --tail 40 2>&1")

    # verify new code markers (loginViaBrowsers / normalizeToken)
    run(
        c,
        "docker exec ds-gateway node -e \"const s=require('fs').readFileSync('./src/ds-login.js','utf8');"
        "console.log('hasLoginViaBrowsers', s.includes('loginViaBrowsers'));"
        "console.log('hasNormalizeToken', s.includes('normalizeToken'));\"",
    )

    # public health
    run(c, "curl -sI http://127.0.0.1:19728/panel/ | head -8")
    c.close()
    print("\nDEPLOY_BUILD3_DONE")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)
