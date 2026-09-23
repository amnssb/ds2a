#!/usr/bin/env python3
"""Retry ds-gateway docker build with registry mirror fixes."""
import sys
import time
import paramiko

HOST = "166.1.232.147"
USER = "root"
PASS = "Aa11012345"
REPO_DIR = "/root/ds2a"


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

    # inspect registry mirrors
    run(c, "cat /etc/docker/daemon.json 2>/dev/null || echo NO_DAEMON_JSON")
    run(c, "docker info 2>/dev/null | sed -n '1,80p'")

    # write a safer daemon.json with multiple mirrors (backup first)
    run(c, "cp -n /etc/docker/daemon.json /etc/docker/daemon.json.bak 2>/dev/null || true")
    daemon = r'''{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.com",
    "https://mirror.ccs.tencentyun.com",
    "https://docker.1panel.live",
    "https://hub.rat.dev"
  ]
}
'''
    # use python on server to write file to avoid quoting issues
    run(c, "python3 - <<'PY'\nimport json,os\np='/etc/docker/daemon.json'\nmirrors=['https://docker.m.daocloud.io','https://dockerproxy.com','https://mirror.ccs.tencentyun.com','https://docker.1panel.live','https://hub.rat.dev']\ndata={}\nif os.path.exists(p):\n    try:\n        data=json.load(open(p))\n    except Exception:\n        data={}\ndata['registry-mirrors']=mirrors\njson.dump(data, open(p,'w'), indent=2)\nprint(open(p).read())\nPY")

    run(c, "systemctl reload docker || systemctl restart docker", timeout=120)
    time.sleep(3)
    run(c, "docker info 2>/dev/null | grep -A20 'Registry Mirrors' || true")

    # try pull base image first
    rc, out = run(c, "docker pull node:20-alpine", timeout=300, stream=True)
    if rc != 0:
        print("mirror pull failed, trying direct docker.io")
        run(c, "docker pull docker.io/library/node:20-alpine", timeout=300, stream=True)

    # rebuild
    print("\n=== rebuild ===")
    rc, out = run(c, f"cd {REPO_DIR} && docker compose build 2>&1", timeout=600, stream=True)
    if rc != 0:
        print("compose build failed, trying plain docker build")
        rc, out = run(c, f"cd {REPO_DIR} && docker build -t ds-gateway:latest . 2>&1", timeout=600, stream=True)
        if rc != 0:
            print("BUILD_FAILED")
            c.close()
            sys.exit(1)

    run(c, f"cd {REPO_DIR} && docker compose up -d --force-recreate 2>&1", timeout=180, stream=True)
    time.sleep(5)
    run(c, "docker ps --filter name=ds-gateway")
    run(c, "curl -fsS http://127.0.0.1:19728/health; echo")
    run(c, "docker logs ds-gateway --tail 50 2>&1 | iconv -f UTF-8 -t UTF-8 -c || docker logs ds-gateway --tail 50 2>&1")
    # verify new code markers
    run(c, "docker exec ds-gateway node -e \"const a=require('./src/auth'); console.log('hasReset', typeof a.resetUsage); const k=require('./src/routes/keys'); console.log('keys_ok', !!k.requireAdmin);\"")
    c.close()
    print("\nDEPLOY_RETRY_DONE")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)
