import Fastify from 'fastify'
import { testDB } from './services/db'
import { testRedis } from './services/redis'
import queue from './services/queue'

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

const start = async () => {
  try {
    await app.listen({ port: 3001, host: '0.0.0.0' })
    console.log('Server running on port 3001')
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

start()