#!/usr/bin/env python3
"""Fix docker mirrors and rebuild ds-gateway."""
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

    # write multiple candidate mirrors; skip 1panel (403)
    script = r'''
import json,os,urllib.request,ssl,time
p='/etc/docker/daemon.json'
# candidate mirrors to try (HEAD /v2/)
candidates=[
  'https://docker.m.daocloud.io',
  'https://dockerproxy.com',
  'https://mirror.ccs.tencentyun.com',
  'https://hub.rat.dev',
  'https://docker.1ms.run',
  'https://docker.chenby.cn',
  'https://docker.unsee.tech',
  'https://dockerpull.org',
  'https://registry.dockermirror.com',
  'https://docker.mirrors.ustc.edu.cn',
  'https://docker.nju.edu.cn',
]
ctx=ssl.create_default_context()
ok=[]
for m in candidates:
    url=m.rstrip('/')+'/v2/'
    try:
        req=urllib.request.Request(url, method='GET')
        with urllib.request.urlopen(req, timeout=6, context=ctx) as r:
            code=r.getcode()
        # 401 is also fine for registry auth challenge
        if code in (200,401):
            ok.append(m)
            print('OK', m, code)
        else:
            print('BAD', m, code)
    except Exception as e:
        print('FAIL', m, type(e).__name__, e)
if not ok:
    # last resort: empty mirrors -> direct docker.io
    ok=[]
    print('no mirrors work, using direct docker.io')
data={}
if os.path.exists(p):
    try: data=json.load(open(p))
    except: data={}
data['registry-mirrors']=ok
json.dump(data, open(p,'w'), indent=2)
print('WROTE', data)
'''
    run(c, f"python3 - <<'PY'\n{script}\nPY", timeout=120)
    run(c, "systemctl restart docker", timeout=120)
    time.sleep(4)
    run(c, "docker info 2>/dev/null | grep -A15 'Registry Mirrors' || true")

    # try pull with retries
    pulled = False
    for attempt in range(1, 6):
        rc, _ = run(c, "docker pull node:20-alpine", timeout=300, stream=True)
        if rc == 0:
            pulled = True
            break
        print(f"pull attempt {attempt} failed, retrying in 8s...")
        time.sleep(8)

    if not pulled:
        # try alternate tags/registries
        print("trying alternate image refs...")
        for ref in (
            "docker.io/library/node:20-alpine",
            "node:20",
            "node:20-slim",
            "library/node:20-alpine",
        ):
            rc, _ = run(c, f"docker pull {ref}", timeout=300, stream=True)
            if rc == 0:
                pulled = True
                # if not 20-alpine, rewrite Dockerfile FROM lines temporarily? better only accept node:20-alpine
                break

    if not pulled:
        print("PULL_FAILED")
        c.close()
        sys.exit(1)

    # rebuild
    print("\n=== rebuild ===")
    rc, _ = run(c, f"cd {REPO_DIR} && docker compose build 2>&1", timeout=600, stream=True)
    if rc != 0:
        rc, _ = run(c, f"cd {REPO_DIR} && docker build -t ds-gateway:latest . 2>&1", timeout=600, stream=True)
        if rc != 0:
            print("BUILD_FAILED")
            c.close()
            sys.exit(1)

    run(c, f"cd {REPO_DIR} && docker compose up -d --force-recreate 2>&1", timeout=180, stream=True)
    time.sleep(5)
    run(c, "docker ps --filter name=ds-gateway --format '{{.Names}} {{.Status}} {{.Ports}}'")
    run(c, "curl -fsS http://127.0.0.1:19728/health; echo")
    run(c, "docker logs ds-gateway --tail 30 2>&1")
    # verify new code markers
    run(c, "docker exec ds-gateway node -e \"const a=require('./src/auth'); console.log('hasReset', typeof a.resetUsage);\"")
    c.close()
    print("\nDEPLOY_RETRY2_DONE")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)
