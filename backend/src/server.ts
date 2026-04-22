import Fastify from 'fastify'
import { historyRoutes } from './routes/history'
import queue from './services/queue'
import redis from './services/redis'
import cors from '@fastify/cors'
import { io } from './socket'
export { io }

// ── RATE LIMITING CONFIG ─────────────────────────────────────────────────────
// Redis-based sliding window: max 10 executions per IP per 60 seconds.
// Using Redis INCR + EXPIRE — atomic, works even if server restarts.
const RL_WINDOW_SEC = 60
const RL_MAX_REQ    = 10

const app = Fastify({ trustProxy: true })   // trustProxy lets req.ip work behind nginx / Railway / Render

app.register(historyRoutes)

app.get('/health', async () => ({ status: 'ok' }))

app.post('/run', async (req, reply) => {
  // ── RATE LIMIT CHECK ──────────────────────────────────
  const clientIp =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() ||
    req.ip ||
    'unknown'

  const rlKey   = `rl:${clientIp}`
  const reqCount = await redis.incr(rlKey)
  if (reqCount === 1) await redis.expire(rlKey, RL_WINDOW_SEC)

  if (reqCount > RL_MAX_REQ) {
    const ttl = await redis.ttl(rlKey)
    return reply.code(429).send({
      error:      'rate_limited',
      message:    `Too many executions. Please wait ${ttl} second${ttl !== 1 ? 's' : ''}.`,
      retryAfter: ttl,
    })
  }
  // ─────────────────────────────────────────────────────

  const { code, language, stdin = '' } = req.body as any

  if (!code || !language) {
    return reply.code(400).send({ error: 'code and language are required' })
  }

  const job = await queue.add('execute', { code, language, stdin })

  return { jobId: job.id }
})

// ── RESULT POLLING FALLBACK (for clients that miss socket events) ────────────
app.get('/result/:id', async (req, reply) => {
  const { id } = req.params as any
  const job    = await queue.getJob(id)

  if (!job) return { status: 'not_found' }

  const state = await job.getState()

  if (state === 'completed') {
    return {
      status:  'completed',
      output:  job.returnvalue?.output || null,
      runtime: job.returnvalue?.runtime || null,
    }
  }

  if (state === 'failed') {
    return { status: 'failed', error: job.failedReason }
  }

  return { status: state }   // waiting | active | delayed
})

const start = async () => {
  try {
    await app.register(cors, { origin: '*' })
    await app.listen({ port: 3001, host: '0.0.0.0' })
    console.log('[server] running on port 3001')
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

start()