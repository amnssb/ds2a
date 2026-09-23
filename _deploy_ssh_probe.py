#!/usr/bin/env python3
"""SSH probe + login for ds2a deploy."""
import socket
import sys
import paramiko

HOST = "166.1.232.147"
PASS = "Aa11012345"


def probe():
    for port in (22, 19728, 80, 443, 8080):
        s = socket.socket()
        s.settimeout(4)
        try:
            s.connect((HOST, port))
            print(f"port {port}: OPEN")
        except Exception as e:
            print(f"port {port}: {e}")
        finally:
            s.close()


def login():
    for user in ("root", "ubuntu", "admin", "amnssb"):
        try:
            c = paramiko.SSHClient()
            c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect(
                HOST,
                port=22,
                username=user,
                password=PASS,
                timeout=12,
                allow_agent=False,
                look_for_keys=False,
            )
            print(f"=== LOGIN OK: {user} ===")
            cmds = [
                "hostname; id; uname -a",
                "which docker; docker --version; docker compose version 2>/dev/null || true",
                "docker ps -a 2>/dev/null | head -30",
                "ls -la /root 2>/dev/null; ls -la /opt 2>/dev/null; ls -la /home 2>/dev/null",
                "ss -tlnp 2>/dev/null | head -30 || netstat -tlnp 2>/dev/null | head -30",
                "df -h; free -h",
            ]
            for cmd in cmds:
                stdin, stdout, stderr = c.exec_command(cmd, timeout=30)
                out = stdout.read().decode(errors="replace")
                err = stderr.read().decode(errors="replace")
                print(f"\n$ {cmd}\n{out}")
                if err.strip():
                    print(f"STDERR: {err}")
            # keep connection params for later use
            open("/tmp/ssh_ok", "w").write(user)
            c.close()
            return user
        except Exception as e:
            print(f"login {user} failed: {e}")
    return None


if __name__ == "__main__":
    probe()
    user = login()
    sys.exit(0 if user else 1)
