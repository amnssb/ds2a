#!/usr/bin/env python3
import sys, time, paramiko

HOST = "166.1.232.147"
USER = "root"
PASS = "Aa11012345"
REPO = "/root/ds2a"

def run(c, cmd, timeout=120, stream=False):
    print(f"\n$ {cmd}", flush=True)
    si, so, se = c.exec_command(cmd, timeout=timeout)
    if stream:
        while True:
            line = so.readline()
            if not line and so.channel.exit_status_ready():
                break
            if line:
                print(line, end="", flush=True)
        rc = so.channel.recv_exit_status()
        e = se.read().decode(errors="replace")
        if e.strip():
            print(e, end="", flush=True)
        print(f"[exit {rc}]", flush=True)
        return rc, e
    out = so.read().decode(errors="replace")
    err = se.read().decode(errors="replace")
    rc = so.channel.recv_exit_status()
    print(out, end="")
    if err.strip():
        print("STDERR:", err, end="")
    print(f"[exit {rc}]")
    return rc, out + err

def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, USER, PASS, timeout=15, allow_agent=False, look_for_keys=False)
    print("SSH connected")

    # 1) git pull latest
    run(c, f"cd {REPO} && git fetch origin && git status -sb && git pull --ff-only origin main", timeout=90)
    run(c, f"cd {REPO} && git log --oneline -3")

    # 2) tag existing image as local node base (keep first base forever)
    run(c, "docker tag ds-gateway:latest ds-node20:alpine || true")
    run(c, "docker images | grep -E 'ds-node20|ds-gateway' || true")

    # 3) ensure compose uses local base without pull
    # write override for build args
    override = f"""
services:
  gateway:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        NODE_IMAGE: ds-node20:alpine
"""
    # write via python on server to avoid quoting hell
    script = (
        "import pathlib\n"
        "p=pathlib.Path('/root/ds2a/docker-compose.build.yml')\n"
        "p.write_text('''" + override + "''')\n"
        "print(p.read_text())\n"
    )
    run(c, "python3 - <<'PY'\n" + script + "PY")

    # 4) apk mirror to tuna inside build via extra hosts not needed if packages exist;
    # Dockerfile still runs apk - rewrite repositories first with a tiny pre-step image? 
    # Simpler: patch Dockerfile sed on server for this deploy only if missing
    run(c, f"cd {REPO} && grep -n 'NODE_IMAGE\\|dl-cdn\\|tuna' Dockerfile | head")

    # 5) build without --pull
    run(c, f"cd {REPO} && docker compose -f docker-compose.yml -f docker-compose.build.yml build --build-arg NODE_IMAGE=ds-node20:alpine", timeout=600, stream=True)

    # 6) up
    run(c, f"cd {REPO} && docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --force-recreate", timeout=180, stream=True)
    time.sleep(5)

    run(c, "docker ps --filter name=ds-gateway --format '{{.Names}} {{.Status}} {{.Ports}}'")
    run(c, "curl -fsS http://127.0.0.1:19728/health; echo")
    run(c, "docker logs ds-gateway --tail 40 2>&1")
    # verify new code marker
    run(c, "docker exec ds-gateway node -e \"const s=require('fs').readFileSync('./src/ds-login.js','utf8'); console.log('hasNormalizeToken', s.includes('normalizeToken')); console.log('hasLoginViaBrowsers', s.includes('loginViaBrowsers'));\"")

    c.close()
    print("OFFLINE_DEPLOY_DONE")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ERROR:", e)
        sys.exit(1)
