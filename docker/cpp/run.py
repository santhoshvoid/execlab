#!/usr/bin/env python3
"""
ExecLab C++ runner.
1. Parses code + user-stdin from the <<<STDIN>>> separator.
2. Writes code to /tmp/solution.cpp.
3. Compiles with g++. Compilation errors go straight to stderr (streamed).
4. If compilation succeeds, runs the binary with user-stdin piped in.
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

with open('/tmp/solution.cpp', 'wb') as f:
    f.write(code_bytes)

# ── COMPILE ─────────────────────────────────────────────
# stderr=None → compilation errors stream directly to parent
compile_proc = subprocess.run(
    ['g++', '-o', '/tmp/solution', '/tmp/solution.cpp'],
    stdout=None,
    stderr=None,
)
if compile_proc.returncode != 0:
    sys.exit(compile_proc.returncode)

# ── RUN ─────────────────────────────────────────────────
run_proc = subprocess.Popen(
    ['/tmp/solution'],
    stdin=subprocess.PIPE,
    stdout=None,   # inherit
    stderr=None,   # inherit
)
run_proc.stdin.write(user_stdin)
run_proc.stdin.close()
sys.exit(run_proc.wait())