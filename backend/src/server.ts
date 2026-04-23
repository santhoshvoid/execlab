import Fastify          from 'fastify'
import cors             from '@fastify/cors'
import { Server as SocketServer } from 'socket.io'
import { historyRoutes } from './routes/history'
import { saveSubmission } from './services/saveSubmission'

// ─────────────────────────────────────────────────────────────────────────────
//  EXECUTION MODE
//  'piston'  (default) → Piston public API   → use for Render deployment
//  'docker'            → BullMQ + local worker → use locally with Docker
// ─────────────────────────────────────────────────────────────────────────────
const EXEC_MODE = (process.env.EXECUTION_MODE || 'piston') as 'piston' | 'docker'
console.log(`[server] execution mode: ${EXEC_MODE}`)

// ─────────────────────────────────────────────────────────────────────────────
//  IN-MEMORY RATE LIMITER
//  Works without Redis. Simple sliding window per IP.
//  Resets automatically via the expiry map.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
//  RATE LIMIT (AUTO SWITCH: REDIS for docker, MEMORY for piston)
// ─────────────────────────────────────────────────────────
let checkRateLimitFn: (ip: string) => Promise<{ allowed: boolean; retryAfter?: number }>

if (EXEC_MODE === 'docker') {
  console.log('[rate-limit] using REDIS (local mode)')

  checkRateLimitFn = async (ip: string) => {
    const { default: redis } = await import('./services/redis')

    const RL_WINDOW_SEC = 60
    const RL_MAX_REQ    = 10

    const rlKey    = `rl:${ip}`
    const reqCount = await redis.incr(rlKey)

    if (reqCount === 1) await redis.expire(rlKey, RL_WINDOW_SEC)

    if (reqCount > RL_MAX_REQ) {
      const ttl = await redis.ttl(rlKey)
      return { allowed: false, retryAfter: ttl }
    }

    return { allowed: true }
  }

} else {
  console.log('[rate-limit] using MEMORY (piston mode)')

  const rlMap = new Map<string, { count: number; resetAt: number }>()
  const RL_MAX    = 10
  const RL_WINDOW = 60_000

  checkRateLimitFn = async (ip: string) => {
    const now  = Date.now()
    const slot = rlMap.get(ip)

    if (!slot || now > slot.resetAt) {
      rlMap.set(ip, { count: 1, resetAt: now + RL_WINDOW })
      return { allowed: true }
    }

    slot.count += 1

    if (slot.count > RL_MAX) {
      return {
        allowed: false,
        retryAfter: Math.ceil((slot.resetAt - now) / 1000),
      }
    }

    return { allowed: true }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PISTON CONFIG
//  Public API — free, no auth, supports all 4 languages.
//  https://github.com/engineer-man/piston
// ─────────────────────────────────────────────────────────────────────────────
const PISTON_URL = 'https://emkc.org/api/v2/piston/execute'

const PISTON_LANGS: Record<string, { language: string; version: string }> = {
  python:     { language: 'python',     version: '3.10.0' },
  javascript: { language: 'javascript', version: '18.15.0' },
  cpp:        { language: 'c++',        version: '10.2.0' },
  java:       { language: 'java',       version: '15.0.2' },
}

// ─────────────────────────────────────────────────────────────────────────────
//  FASTIFY + SOCKET.IO
//  In piston mode   → socket.io is attached to the SAME http server (same port).
//                     Render only exposes one port, so this is required.
//  In docker mode   → socket.io is on port 3002 (worker's process, unchanged).
// ─────────────────────────────────────────────────────────────────────────────
const app = Fastify({ trustProxy: true })

// We create the Socket.io server on the Fastify raw http.Server BEFORE listen()
// so the upgrade handler is registered in time.
let io: SocketServer | null = null
if (EXEC_MODE === 'piston') {
  io = new SocketServer(app.server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
  })
  console.log('[socket.io] attached to fastify http server (same port)')
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.register(historyRoutes)

app.get('/health', async () => ({ status: 'ok', mode: EXEC_MODE }))

app.post('/run', async (req, reply) => {
  // ── RATE LIMIT ─────────────────────────────────────────
  const clientIp =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() ||
    req.ip ||
    'unknown'

  const rl = await checkRateLimitFn(clientIp)
  if (!rl.allowed) {
    return reply.code(429).send({
      error:      'rate_limited',
      message:    `Too many executions. Please wait ${rl.retryAfter} second${rl.retryAfter !== 1 ? 's' : ''}.`,
      retryAfter: rl.retryAfter,
    })
  }

  const { code, language, stdin = '' } = req.body as any
  if (!code || !language) {
    return reply.code(400).send({ error: 'code and language are required' })
  }

  // ── DOCKER / BULLMQ MODE ───────────────────────────────
  if (EXEC_MODE === 'docker') {
    const { default: queue } = await import('./services/queue')
    const job = await queue.add('execute', { code, language, stdin })
    return { jobId: job.id }
  }

  // ── PISTON MODE ────────────────────────────────────────
  const langConfig = PISTON_LANGS[language]
  if (!langConfig) {
    return reply.code(400).send({ error: `Unsupported language: ${language}` })
  }

  // Generate a unique job ID for socket.io event routing
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

  // Fire-and-forget: Piston call happens async, results come over socket
  runPiston(jobId, langConfig, code, stdin, Date.now()).catch(console.error)

  return { jobId }
})

// Polling fallback (not needed in piston mode but kept so frontend doesn't 404)
app.get('/result/:id', async () => ({ status: 'pending' }))

// ─────────────────────────────────────────────────────────────────────────────
//  PISTON EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
async function runPiston(
  jobId:      string,
  langConfig: { language: string; version: string },
  code:       string,
  stdin:      string,
  startTime:  number
) {
  if (!io) return   // shouldn't happen in piston mode

  try {
    const pistonResp = await fetch(PISTON_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language:        langConfig.language,
        version:         langConfig.version,
        files:           [{ name: 'main', content: code }],
        stdin:           stdin,
        run_timeout:     15000,   // 15s execution timeout
        compile_timeout: 30000,   // 30s compile timeout (C++/Java)
      }),
      // Hard total timeout: Piston + network
      signal: AbortSignal.timeout(45_000),
    })

    if (!pistonResp.ok) {
      const errText = await pistonResp.text().catch(() => '')
      throw new Error(`Piston error ${pistonResp.status}: ${errText}`)
    }

    const result = (await pistonResp.json()) as {
      compile?: { stdout: string; stderr: string; code: number | null }
      run:      { stdout: string; stderr: string; output: string; code: number | null }
    }

    const runtime = Date.now() - startTime

    // ── Compilation errors (C++, Java) ──
    if (result.compile && (result.compile.code !== 0) && result.compile.stderr) {
      // Compilation failed — treat whole output as stderr (red in terminal)
      io.emit(`job:${jobId}`, {
        chunk: result.compile.stderr,
        type:  'stderr',
      })
      io.emit(`job:${jobId}`, {
        status:   'error',
        exitCode: result.compile.code ?? 1,
        output:   result.compile.stderr,
        runtime,
      })
      return
    }

    const stdout   = result.run.stdout  || ''
    const stderr   = result.run.stderr  || ''
    const exitCode = result.run.code    ?? 0

    // Emit stdout (green)
    if (stdout) {
      io.emit(`job:${jobId}`, { chunk: stdout, type: 'stdout' })
    }
    // Emit stderr (red) — even on exit 0 (e.g. Python warnings)
    if (stderr) {
      io.emit(`job:${jobId}`, { chunk: stderr, type: 'stderr' })
    }

    // Final status event
    if (exitCode !== 0) {
      io.emit(`job:${jobId}`, { status: 'error',     exitCode, output: stdout + stderr, runtime })
    } else {
      io.emit(`job:${jobId}`, { status: 'completed', exitCode: 0, output: stdout,       runtime })
    }

    // Save to Supabase (non-blocking)
    saveSubmission({ code, language: langConfig.language, output: stdout + stderr, runtime })
      .catch(err => console.error('[saveSubmission]', err))

  } catch (err: any) {
    const runtime = Date.now() - startTime
    const msg = err?.name === 'TimeoutError'
      ? 'Execution timed out (45s)'
      : (err?.message || 'Piston API unreachable')

    io.emit(`job:${jobId}`, { status: 'failed', error: msg, runtime })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await app.register(cors, { origin: '*' })
    const port = Number(process.env.PORT) || 3001   // Render injects PORT automatically
    await app.listen({ port, host: '0.0.0.0' })
    console.log(`[server] listening on port ${port}`)
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

start()