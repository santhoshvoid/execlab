import 'dotenv/config'
import { Worker }     from 'bullmq'
import Redis          from 'ioredis'
import { io }        from './socket'
import { spawn, ChildProcess } from 'child_process'
import { saveSubmission }      from './services/saveSubmission'

// ── REDIS CONNECTION (BullMQ) ────────────────────────────
const connection = new Redis(
  process.env.REDIS_URL || 'redis://localhost:6379',
  { maxRetriesPerRequest: null }
)

// ── ACTIVE PROCESS REGISTRY (for cancellation) ──────────
// Maps jobId → spawned ChildProcess so we can kill on demand.
const activePids = new Map<string, ChildProcess>()

// ── CANCEL HANDLER ───────────────────────────────────────
// The frontend emits 'cancel' directly to the worker's Socket.io
// (port 3002), which is the same socket the output streams come from.
const registerCancelHandler = (socket: any) => {
  socket.on('cancel', (jobId: string) => {
    console.log(`[worker] cancel requested for job ${jobId}`)
    const proc = activePids.get(jobId)
    if (proc) {
      proc.kill('SIGTERM')
      // activePids entry removed inside the exit handler
    }
  })
}

// Register for existing connections (in case worker starts after frontend connects)
io.sockets.sockets.forEach(registerCancelHandler)
// Register for all future connections
io.on('connection', registerCancelHandler)

// ── LANGUAGE → IMAGE MAP ─────────────────────────────────
const IMAGES: Record<string, string> = {
  python:     'execlab-python-runner',
  javascript: 'execlab-node-runner',
  cpp:        'execlab-cpp-runner',
  java:       'execlab-java-runner',
}

// ── EXECUTION TIMEOUTS (ms) ──────────────────────────────
// Python / JS: 15s   — more than enough for any script
// C++ / Java:  30s   — compilation adds ~5–15 s on limited CPU (0.5 cores)
const TIMEOUTS: Record<string, number> = {
  python:     15_000,
  javascript: 15_000,
  cpp:        30_000,
  java:       30_000,
}

// ── STDIN SEPARATOR ──────────────────────────────────────
// The runner scripts inside each Docker image read this separator
// to split the user's *code* from the program's *stdin input*.
const SEP = '\n<<<STDIN>>>\n'

// ── CORE EXECUTOR ───────────────────────────────────────
// All 4 languages go through this single function — spawn-based,
// real streaming (no buffering), cancel-able, exit-code-aware.
function execInDocker(
  jobId:     string,
  image:     string,
  language:  string,
  code:      string,
  stdin:     string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now()

    const proc = spawn('docker', [
      'run', '--rm', '-i',
      '--memory=128m',
      '--cpus=0.5',
      '--pids-limit=64',
      '--network=none',
      image,
    ])

    let finished = false
    activePids.set(jobId, proc)

    // ── HARD TIMEOUT ──────────────────────────────────
    const timeoutId = setTimeout(() => {
      if (!finished) {
        finished = true
        activePids.delete(jobId)
        proc.kill('SIGTERM')
        io.emit(`job:${jobId}`, {
          status:  'failed',
          error:   `Execution timed out after ${timeoutMs / 1000}s`,
          runtime: timeoutMs,
        })
        resolve()
      }
    }, timeoutMs)

    // ── SEND CODE + STDIN VIA CONTAINER'S STDIN ───────
    // Runner scripts inside the container parse this format.
    const payload = stdin ? `${code}${SEP}${stdin}` : code
    proc.stdin.write(payload)
    proc.stdin.end()

    let finalOutput = ''

    // ── STREAM STDOUT ─────────────────────────────────
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      finalOutput += text
      io.emit(`job:${jobId}`, { chunk: text, type: 'stdout' })
    })

    // ── STREAM STDERR ─────────────────────────────────
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      finalOutput += text
      // Emit stderr chunks so the terminal colours them red
      io.emit(`job:${jobId}`, { chunk: text, type: 'stderr' })
    })

    // ── EXIT ──────────────────────────────────────────
    proc.on('exit', async (exitCode, signal) => {
      if (finished) return
      finished = true
      activePids.delete(jobId)
      clearTimeout(timeoutId)

      const runtime    = Date.now() - start
      const cancelled  = signal === 'SIGTERM' || signal === 'SIGKILL'

      // Determine status:
      //   cancelled  → user pressed Stop
      //   completed  → exit code 0 (success)
      //   error      → exit code != 0 (syntax / runtime error)
      const status = cancelled
        ? 'cancelled'
        : exitCode === 0 ? 'completed' : 'error'

      io.emit(`job:${jobId}`, {
        status,
        exitCode: exitCode ?? 1,
        output:   finalOutput,
        runtime,
      })

      // Persist to Supabase (skip cancelled runs)
      if (!cancelled) {
        saveSubmission({ code, language, output: finalOutput, runtime })
          .catch(err => console.error('[saveSubmission]', err))
      }

      resolve()
    })

    // ── SPAWN ERROR (docker not found, image missing, etc.) ──
    proc.on('error', (err) => {
      if (finished) return
      finished = true
      activePids.delete(jobId)
      clearTimeout(timeoutId)
      io.emit(`job:${jobId}`, { status: 'failed', error: err.message })
      resolve()
    })
  })
}

// ── BULLMQ WORKER ────────────────────────────────────────
const worker = new Worker(
  'code-execution',
  async (job) => {
    const { code, language, stdin = '' } = job.data
    const jobId = job.id as string

    console.log(`[worker] job ${jobId} | lang: ${language}`)

    const image = IMAGES[language]
    if (!image) {
      io.emit(`job:${jobId}`, {
        status: 'failed',
        error:  `Unsupported language: ${language}`,
      })
      return { status: 'failed' }
    }

    const timeoutMs = TIMEOUTS[language] || 15_000
    await execInDocker(jobId, image, language, code, stdin, timeoutMs)

    return { status: 'done' }
  },
  { connection }
)

worker.on('error', (err) => console.error('[worker error]', err))
console.log('[worker] started — waiting for jobs...')