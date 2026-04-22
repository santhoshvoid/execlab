import { Worker } from 'bullmq'
import { execa } from 'execa'
import Redis from 'ioredis'

const connection = new Redis(
  process.env.REDIS_URL || 'redis://localhost:6379',
  {
    maxRetriesPerRequest: null
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

        // ✅ FIXED RETURN
        return {
          output: stdout || stderr
        }

      } catch (err: any) {
        console.error('Execution error FULL:', err)

        return {
          output: err?.stderr || err?.message || 'Execution failed'
        }
      }
    }

    return {
      output: 'Unsupported language'
    }
  },
  {
    connection
  }
)

console.log('Worker started')