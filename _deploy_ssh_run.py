#!/usr/bin/env python3
"""Pull latest from GitHub on server and redeploy ds-gateway via docker compose."""
import sys
import time
import paramiko

HOST = "166.1.232.147"
USER = "root"
PASS = "Aa11012345"
REPO_DIR = "/root/ds2a"


def run(c, cmd, timeout=180, stream=False):
    print(f"\n$ {cmd}")
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
        print(f"[exit {rc}]")
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

    # inspect existing deploy
    run(c, f"ls -la {REPO_DIR} | head -40")
    run(c, f"cd {REPO_DIR} && git remote -v && git status -sb && git log --oneline -3")

    # ensure .env exists
    rc, _ = run(c, f"test -f {REPO_DIR}/.env && echo HAS_ENV || echo NO_ENV")
    if "NO_ENV" in _:
        run(c, f"cd {REPO_DIR} && cp -n .env.example .env || true")

    # pull latest (preserve local data/)
    rc, out = run(
        c,
        f"cd {REPO_DIR} && git fetch origin && git status -sb && git pull --ff-only origin main",
        timeout=120,
    )
    if rc != 0:
        print("git pull failed, attempting reset")
        run(c, f"cd {REPO_DIR} && git stash push -u -m local || true", timeout=60)
        run(c, f"cd {REPO_DIR} && git fetch origin && git reset --hard origin/main", timeout=120)

    run(c, f"cd {REPO_DIR} && git log --oneline -3 && git rev-parse HEAD")

    # rebuild + up
    print("\n=== docker compose build/up ===")
    rc, out = run(
        c,
        f"cd {REPO_DIR} && docker compose build --pull 2>&1 && docker compose up -d 2>&1",
        timeout=600,
        stream=True,
    )

    # status
    time.sleep(3)
    run(c, f"cd {REPO_DIR} && docker compose ps")
    run(c, "docker ps --filter name=ds-gateway --format '{{.Names}} {{.Status}} {{.Ports}}'")

    # health inside container + via published port
    run(c, "sleep 3; curl -fsS http://127.0.0.1:19728/health || true")
    run(c, "docker logs ds-gateway --tail 40 2>&1")

    # public panel check
    run(c, "curl -sI http://127.0.0.1:19728/panel/ | head -10")

    c.close()
    print("\nDEPLOY_SCRIPT_DONE")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)
