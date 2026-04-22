import Fastify from 'fastify'
import { testDB } from './services/db'
import { testRedis } from './services/redis'
import queue from './services/queue'
import { Job } from 'bullmq'
import cors from '@fastify/cors'

const app = Fastify()


app.get('/health', async () => {
  try {
    const db = await testDB()
    const redis = await testRedis()

    return {
      status: 'ok',
      db,
      redis
    }
  } catch (err) {
    return {
      status: 'error',
      error: String(err)
    }
  }
})

app.post('/run', async (req, reply) => {
  const { code, language } = req.body as any

  const job = await queue.add('execute', {
    code,
    language
  })

  return {
    jobId: job.id
  }
})

/* ✅ NEW ROUTE (RESULT API) */
app.get('/result/:id', async (req, reply) => {
  const { id } = req.params as any

  const job = await queue.getJob(id)

  if (!job) {
    return { status: 'not_found' }
  }

  const state = await job.getState()

  if (state === 'completed') {
    return {
      status: 'completed',
      output: job.returnvalue?.output || null
    }
  }

  if (state === 'failed') {
    return {
      status: 'failed',
      error: job.failedReason
    }
  }

  return {
    status: state // waiting | active | delayed
  }
})

const start = async () => {
  try {
    await app.register(cors, {
      origin: '*'
    })

    await app.listen({ port: 3001, host: '0.0.0.0' })
    console.log('Server running on port 3001')
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

start()

