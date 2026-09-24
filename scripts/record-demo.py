#!/usr/bin/env python3
"""
Records the README terminal demo (.github/assets/demo.svg).

It runs the real `npx permly init` and `npx permly migrate` in a fresh project, inside a
pseudo-terminal, types the answers like a person would, and saves the output as an
asciicast. svg-term-cli (run with npx, not a dependency) turns that into an animated SVG.

Needs: python3 (standard library only), a built package (`npm run build`), and the
docker compose MySQL (`npm run db:up`).

    python3 scripts/record-demo.py
"""
import json
import os
import pty
import select
import shutil
import subprocess
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, ".github", "assets", "demo.svg")
WIDTH, HEIGHT = 110, 38
MAX_GAP = 0.6  # long real pauses (npx startup, network) are shortened in the recording

DB_ADMIN = ["docker", "compose", "exec", "-T", "mysql", "mysql", "-uroot", "-ppermly", "-e"]
DEMO_URL = "mysql://app:demo-password@localhost:33061/shop"


def run(cmd, **kwargs):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)


class Recorder:
    def __init__(self):
        self.events = []
        self.clock = 0.0

    def emit(self, text, delay=0.0):
        self.clock += delay
        self.events.append([round(self.clock, 3), "o", text])

    def prompt(self):
        self.emit("\x1b[1;32m~/shop\x1b[0m \x1b[2m$\x1b[0m ", 0.4)

    def type(self, text):
        for char in text:
            self.emit(char, 0.06)
        self.emit("\r\n", 0.25)

    def command(self, cwd, env, argv, answers):
        """Runs argv in a pty. `answers` is a list of (text to wait for, what to type)."""
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        pending = list(answers)
        buffer = ""
        last = time.monotonic()
        while True:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                try:
                    data = os.read(fd, 4096).decode("utf-8", "replace")
                except OSError:
                    break
                if not data:
                    break
                now = time.monotonic()
                self.emit(data, min(now - last, MAX_GAP))
                last = now
                buffer += data
            if pending and pending[0][0] in buffer:
                wait_for, answer = pending.pop(0)
                buffer = buffer.split(wait_for, 1)[1]
                time.sleep(0.7)  # a person reading the question
                for char in answer:
                    os.write(fd, char.encode())
                    time.sleep(0.09)
                os.write(fd, b"\r")
        os.waitpid(pid, 0)


def main():
    subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    work = tempfile.mkdtemp(prefix="permly-demo-")
    project = os.path.join(work, "shop")
    os.makedirs(os.path.join(project, "src"))
    try:
        # A fresh project with permly (the packed tarball) and mysql2 installed, off camera.
        tarball = subprocess.run(
            ["npm", "pack", "--pack-destination", work], cwd=ROOT, check=True, capture_output=True, text=True
        ).stdout.strip().splitlines()[-1]
        with open(os.path.join(project, "package.json"), "w") as file:
            json.dump({"name": "shop", "private": True, "type": "module"}, file)
        run(["npm", "install", "--no-audit", "--no-fund", os.path.join(work, tarball), "mysql2"], cwd=project)

        # A demo database and user, so the recording shows a realistic URL (password hidden).
        run(DB_ADMIN + ["DROP DATABASE IF EXISTS shop; CREATE DATABASE shop; "
                        "DROP USER IF EXISTS 'app'@'%'; CREATE USER 'app'@'%' IDENTIFIED BY 'demo-password'; "
                        "GRANT ALL ON shop.* TO 'app'@'%';"], cwd=ROOT)

        env = {
            "PATH": os.path.join(project, "node_modules", ".bin") + os.pathsep + os.environ["PATH"],
            "HOME": os.environ.get("HOME", work),
            "TERM": "xterm-256color",
            "COLUMNS": str(WIDTH),
            "LINES": str(HEIGHT),
            "npm_config_update_notifier": "false",
            "DATABASE_URL": DEMO_URL,
        }

        rec = Recorder()
        rec.prompt()
        rec.type("npx permly init")
        rec.command(project, env, ["npx", "permly", "init"], [
            ("Database?", "1"),
            ("Table prefix?", ""),
            ("Folder for the migration file?", ""),
            ("Use these settings?", "y"),
        ])
        rec.prompt()
        rec.type("npx permly migrate")
        rec.command(project, env, ["npx", "permly", "migrate"], [("Create the tables?", "y")])
        rec.prompt()
        rec.emit("", 3.0)  # hold the last frame

        cast = os.path.join(work, "demo.cast")
        with open(cast, "w") as file:
            file.write(json.dumps({"version": 2, "width": WIDTH, "height": HEIGHT}) + "\n")
            for event in rec.events:
                file.write(json.dumps(event) + "\n")

        if os.environ.get("DEMO_KEEP_CAST"):  # for previewing single frames: svg-term --at <ms>
            shutil.copy(cast, os.environ["DEMO_KEEP_CAST"])
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        subprocess.run(
            ["npx", "-y", "svg-term-cli", "--in", cast, "--out", OUT, "--window", "--no-cursor",
             "--width", str(WIDTH), "--height", str(HEIGHT), "--padding", "18"],
            check=True, stderr=subprocess.DEVNULL,
        )
        print(f"Wrote {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT) // 1024} KB)")
    finally:
        subprocess.run(DB_ADMIN + ["DROP DATABASE IF EXISTS shop; DROP USER IF EXISTS 'app'@'%';"],
                       cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
