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
    const { getRedis } = await import('./services/redis')
    const redis = getRedis()

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
const JUDGE0_URL = 'https://judge0-ce.p.rapidapi.com'

const JUDGE0_LANGS: Record<string, number> = {
  python: 71,
  javascript: 63,
  cpp: 54,
  java: 62,
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
  const langId = JUDGE0_LANGS[language]
  if (!langId) {
    return reply.code(400).send({ error: `Unsupported language: ${language}` })
  }

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

  runJudge0(jobId, langId, code, stdin, Date.now()).catch(console.error)

  return { jobId }
})

// Polling fallback (not needed in piston mode but kept so frontend doesn't 404)
app.get('/result/:id', async () => ({ status: 'pending' }))

// ─────────────────────────────────────────────────────────────────────────────
//  PISTON EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
async function runJudge0(
  jobId: string,
  languageId: number,
  code: string,
  stdin: string,
  startTime: number
) {
  if (!io) return

  try {
    // STEP 1: Submit code
    const submitRes = await fetch(
      `${JUDGE0_URL}/submissions?base64_encoded=false&wait=false`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rapidapi-key': process.env.JUDGE0_API_KEY!,
          'x-rapidapi-host': 'judge0-ce.p.rapidapi.com',
        },
        body: JSON.stringify({
          language_id: languageId,
          source_code: code,
          stdin: stdin,
        }),
      }
    )

    const submitData = await submitRes.json()
    if (!submitRes.ok) {
      const errText = await submitRes.text()
      throw new Error(`Judge0 submit failed: ${errText}`)
    }
    const token = submitData.token
    if (!token) {
      throw new Error('Judge0 did not return a token')
    }

    // STEP 2: Poll for result
    let result: any = null

    for (let i = 0; i < 10; i++) {
      await new Promise(res => setTimeout(res, 1000))

      const res = await fetch(
        `${JUDGE0_URL}/submissions/${token}?base64_encoded=false`,
        {
          headers: {
            'x-rapidapi-key': process.env.JUDGE0_API_KEY!,
            'x-rapidapi-host': 'judge0-ce.p.rapidapi.com',
          },
        }
      )

      result = await res.json()

      if (result.status?.id >= 3) break
    }

    const runtime = Date.now() - startTime

    const stdout = result.stdout || ''
    const stderr = result.stderr || result.compile_output || ''
    const exitCode = result.status?.id === 3 ? 0 : 1

    if (stdout) {
      io.emit(`job:${jobId}`, { chunk: stdout, type: 'stdout' })
    }

    if (stderr) {
      io.emit(`job:${jobId}`, { chunk: stderr, type: 'stderr' })
    }

    if (exitCode !== 0) {
      io.emit(`job:${jobId}`, {
        status: 'error',
        exitCode,
        output: stdout + stderr,
        runtime,
      })
    } else {
      io.emit(`job:${jobId}`, {
        status: 'completed',
        exitCode: 0,
        output: stdout,
        runtime,
      })
    }

    saveSubmission({
      code,
      language: String(languageId),
      output: stdout + stderr,
      runtime,
    }).catch(console.error)

  } catch (err: any) {
    const runtime = Date.now() - startTime

    io.emit(`job:${jobId}`, {
      status: 'failed',
      error: err.message || 'Judge0 failed',
      runtime,
    })
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