import { Worker } from 'bullmq'
import { execa } from 'execa'
import Redis from 'ioredis'

const connection = new Redis(
  process.env.REDIS_URL || 'redis://localhost:6379',
  {
    maxRetriesPerRequest: null  // required by BullMQ
  }
)

const worker = new Worker(
  'code-execution',
  async job => {
    console.log('Processing job:', job.id)

    const { code, language } = job.data

    if (language === 'python') {
      try {
        const { stdout, stderr } = await execa(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            'execlab-python-runner',
          ],
          {
            input: code
          }
        )

        console.log('Output:', stdout)
        return { output: stdout, error: stderr }

      } catch (err: any) {
        console.error('Execution error:', err)
        return {
          error: err?.stderr || err?.message || 'Unknown error'
        }
      }
    }

    return { error: 'Unsupported language' }
  },
  {
    connection
  }
)

console.log('Worker started')