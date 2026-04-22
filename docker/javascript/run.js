/**
 * ExecLab JavaScript runner.
 * Reads all stdin, splits on <<<STDIN>>> separator, writes code to
 * /tmp/solution.js and spawns node with user-stdin piped in.
 * stdout/stderr inherited → real-time streaming to parent.
 */
'use strict'

const fs    = require('fs')
const { spawn } = require('child_process')

const chunks = []
process.stdin.on('data', d => chunks.push(d))
process.stdin.on('end', () => {
  const data = Buffer.concat(chunks)
  const SEP  = Buffer.from('\n<<<STDIN>>>\n')
  const idx  = data.indexOf(SEP)

  let code, userStdin
  if (idx !== -1) {
    code      = data.slice(0, idx).toString()
    userStdin = data.slice(idx + SEP.length)
  } else {
    code      = data.toString()
    userStdin = Buffer.alloc(0)
  }

  fs.writeFileSync('/tmp/solution.js', code)

  // stdout: 'inherit' → streams directly to parent (real-time)
  // stderr: 'inherit' → same
  const child = spawn('node', ['/tmp/solution.js'], {
    stdio: ['pipe', 'inherit', 'inherit']
  })

  child.stdin.write(userStdin)
  child.stdin.end()

  child.on('exit', code => process.exit(code ?? 0))
  child.on('error', err => {
    process.stderr.write(err.message + '\n')
    process.exit(1)
  })
})