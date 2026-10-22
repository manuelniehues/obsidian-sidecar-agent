# Sidecar Agent – pseudo-terminal helper
# Runs a program in a real PTY and relays it to Obsidian.
#   fd 0 : keystrokes from xterm.js  -> PTY
#   fd 1 : program output           -> xterm.js
#   fd 3 : control channel, lines "R <rows> <cols>" for resizes
# Usage: python3 -I -B -c <this script> <rows> <cols> <program> [args...]
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            n = os.write(fd, view)
        except InterruptedError:
            continue
        except BlockingIOError:
            select.select([], [fd], [], 1.0)
            continue
        view = view[n:]


def main():
    rows, cols = int(sys.argv[1]), int(sys.argv[2])
    cmd = sys.argv[3:]
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.execvp(cmd[0], cmd)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("Failed to start: %s\n" % e)
            os._exit(127)

    def set_size(r, c):
        try:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        except OSError:
            pass

    set_size(rows, cols)

    def terminate(*_):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGHUP, terminate)

    inputs = [0, master]
    try:
        os.fstat(3)
        inputs.append(3)
    except OSError:
        pass
    ctl_buf = b""
    try:
        while True:
            try:
                ready, _, _ = select.select(inputs, [], [], 1.0)
            except InterruptedError:
                continue
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError as e:
                    if e.errno == errno.EIO:  # program exited
                        data = b""
                    else:
                        raise
                if not data:
                    break
                write_all(1, data)
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:  # Obsidian is gone
                    break
                write_all(master, data)
            if 3 in ready:
                data = os.read(3, 4096)
                if not data:
                    inputs.remove(3)
                else:
                    ctl_buf += data
                    while b"\n" in ctl_buf:
                        line, ctl_buf = ctl_buf.split(b"\n", 1)
                        parts = line.decode("ascii", "ignore").split()
                        if len(parts) == 3 and parts[0] == "R":
                            set_size(int(parts[1]), int(parts[2]))
    finally:
        sys.exit(shutdown(pid, master))


def shutdown(pid, master):
    # Ignore further termination signals so the cleanup is not interrupted
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

    def done():
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return 0
        return status if wpid else None

    st = done()
    if st is None:
        # SIGTERM, not SIGHUP: on hang-up (SIGHUP) Claude Code moves a session to the
        # background instead of ending it. SIGTERM really ends it.
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            pass
        end = time.time() + 5
        while st is None and time.time() < end:
            try:
                ready, _, _ = select.select([master], [], [], 0.1)
                if ready:
                    os.read(master, 65536)  # drain and discard, Obsidian no longer reads
            except OSError:
                time.sleep(0.05)
            st = done()
    if st is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        os.close(master)  # close the terminal so a stuck shutdown is released
    except OSError:
        pass
    if st is None:
        try:
            _, st = os.waitpid(pid, 0)
        except ChildProcessError:
            st = 0
    code = os.waitstatus_to_exitcode(st) if st else 0
    return code if code >= 0 else 128 - code


main()
