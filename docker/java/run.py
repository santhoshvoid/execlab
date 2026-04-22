#!/usr/bin/env python3
"""
ExecLab Java runner.
1. Parses code + user-stdin from the <<<STDIN>>> separator.
2. Writes code to /tmp/Main.java (class must be named Main).
3. Compiles with javac. Compilation errors stream to stderr.
4. Runs with `java -cp /tmp Main` with user-stdin piped in.
stdout/stderr both inherited → real-time streaming.
"""
import sys
import subprocess

data = sys.stdin.buffer.read()
SEP  = b'\n<<<STDIN>>>\n'

if SEP in data:
    idx        = data.index(SEP)
    code_bytes = data[:idx]
    user_stdin = data[idx + len(SEP):]
else:
    code_bytes = data
    user_stdin = b''

with open('/tmp/Main.java', 'wb') as f:
    f.write(code_bytes)

# ── COMPILE ─────────────────────────────────────────────
compile_proc = subprocess.run(
    ['javac', '/tmp/Main.java'],
    stdout=None,
    stderr=None,
    cwd='/tmp',
)
if compile_proc.returncode != 0:
    sys.exit(compile_proc.returncode)

# ── RUN ─────────────────────────────────────────────────
run_proc = subprocess.Popen(
    ['java', '-cp', '/tmp', 'Main'],
    stdin=subprocess.PIPE,
    stdout=None,   # inherit
    stderr=None,   # inherit
)
run_proc.stdin.write(user_stdin)
run_proc.stdin.close()
sys.exit(run_proc.wait())