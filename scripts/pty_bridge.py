#!/usr/bin/env python3
"""PTY bridge for Obsidian Agent Terminal.

This script spawns a shell command in a pseudo terminal and forwards:
- stdin -> PTY master
- PTY master -> stdout

Optional control commands can be sent over fd 3:
- RESIZE <rows> <cols>
"""

from __future__ import annotations

import argparse
import fcntl
import os
import pty
import selectors
import signal
import struct
import subprocess
import sys
import termios


def set_winsize(fd: int, rows: int, cols: int) -> None:
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PTY bridge")
    parser.add_argument("--shell", default="/bin/zsh")
    parser.add_argument("--cwd", default="")
    parser.add_argument("--rows", type=int, default=24)
    parser.add_argument("--cols", type=int, default=80)
    parser.add_argument("--command", required=True)
    return parser.parse_args()


def kill_process_group(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return

    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return

    try:
        proc.wait(timeout=1.5)
        return
    except subprocess.TimeoutExpired:
        pass

    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        return


def main() -> int:
    args = parse_args()

    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")

    master_fd, slave_fd = pty.openpty()
    set_winsize(slave_fd, args.rows, args.cols)

    proc = subprocess.Popen(
        [args.shell, "-lc", args.command],
        cwd=args.cwd or None,
        env=env,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave_fd)

    def handle_signal(signum: int, _frame: object) -> None:
        if signum in (signal.SIGINT, signal.SIGTERM):
            kill_process_group(proc)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    selector = selectors.DefaultSelector()
    selector.register(master_fd, selectors.EVENT_READ)
    selector.register(stdin_fd, selectors.EVENT_READ)

    control_fd = 3
    has_control = False
    control_buffer = ""
    try:
        selector.register(control_fd, selectors.EVENT_READ)
        has_control = True
    except OSError:
        has_control = False

    try:
        while True:
            if proc.poll() is not None:
                while True:
                    try:
                        remaining = os.read(master_fd, 4096)
                    except OSError:
                        remaining = b""
                    if not remaining:
                        break
                    os.write(stdout_fd, remaining)
                break

            for key, _events in selector.select(timeout=0.1):
                fd = key.fd
                if fd == master_fd:
                    try:
                        data = os.read(master_fd, 4096)
                    except OSError:
                        data = b""
                    if not data:
                        continue
                    os.write(stdout_fd, data)
                elif fd == stdin_fd:
                    try:
                        data = os.read(stdin_fd, 4096)
                    except OSError:
                        data = b""
                    if not data:
                        continue
                    os.write(master_fd, data)
                elif has_control and fd == control_fd:
                    try:
                        data = os.read(control_fd, 512)
                    except OSError:
                        data = b""
                    if not data:
                        continue
                    control_buffer += data.decode("utf-8", errors="ignore")
                    while "\n" in control_buffer:
                        line, control_buffer = control_buffer.split("\n", 1)
                        line = line.strip()
                        if not line.startswith("RESIZE "):
                            continue
                        parts = line.split()
                        if len(parts) != 3:
                            continue
                        try:
                            rows = int(parts[1])
                            cols = int(parts[2])
                        except ValueError:
                            continue
                        if rows > 0 and cols > 0:
                            set_winsize(master_fd, rows, cols)
                            if proc.poll() is None:
                                os.killpg(proc.pid, signal.SIGWINCH)
    finally:
        kill_process_group(proc)
        try:
            selector.close()
        except Exception:
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass

    return proc.wait()


if __name__ == "__main__":
    raise SystemExit(main())
