#!/usr/bin/env python3
"""
ExecLab Python runner.
Reads ALL of stdin, splits on <<<STDIN>>> separator:
  - everything before  → user's Python code
  - everything after   → input for the program (stdin for input())
Writes code to /tmp/solution.py and runs it via subprocess so that
stdout/stderr stream directly to the parent process (the worker).
"""
import sys
import subprocess

# Read everything from stdin (the worker writes code[+SEP+userinput])
data = sys.stdin.buffer.read()

SEP = b'\n<<<STDIN>>>\n'

if SEP in data:
    idx        = data.index(SEP)
    code_bytes = data[:idx]
    user_stdin = data[idx + len(SEP):]
else:
    code_bytes = data
    user_stdin = b''

# Write code to a temp file
with open('/tmp/solution.py', 'wb') as f:
    f.write(code_bytes)

# Run the code.
# stdout=None / stderr=None → inherited → streams directly to parent process.
# This gives us real-time streaming without any buffering on our side.
proc = subprocess.Popen(
    ['python3', '-u', '/tmp/solution.py'],
    stdin=subprocess.PIPE,
    stdout=None,    # inherit
    stderr=None,    # inherit
)
proc.stdin.write(user_stdin)
proc.stdin.close()
sys.exit(proc.wait())