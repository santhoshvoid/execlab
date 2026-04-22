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
        // ✅ ADD HERE (before execa)
        const start = Date.now()

        const { stdout, stderr } = await execa(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '--memory=128m',
            '--cpus=0.5',
            '--pids-limit=64',
            '--network=none',
            'execlab-python-runner',
          ],
          {
            input: code,
            timeout: 3000,
          }
        )

        // ✅ ADD HERE (after execa)
        const runtime = Date.now() - start

        console.log('Output:', stdout)

        return {
          output: stdout || stderr,
          runtime,
        }

      } catch (err: any) {
        if (err.timedOut) {
          return {
            output: 'Execution timed out (3s limit)',
            runtime: 3000
          }
        }

        return {
          output: err?.stderr || err?.message || 'Execution failed',
          runtime: 0
        }
      }
    }

    if (language === 'javascript') {
      try {
        const start = Date.now()

        const { stdout, stderr } = await execa(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '--memory=128m',
            '--cpus=0.5',
            '--pids-limit=64',
            '--network=none',
            'execlab-node-runner',
          ],
          {
            input: code,
            timeout: 3000,
          }
        )

        const runtime = Date.now() - start

        return { 
          output: stdout || stderr,
          runtime,
        }

      } catch (err: any) {
        if (err.timedOut) {
          return {
            output: 'Execution timed out (3s limit)',
            runtime: 3000
          }
        }

        return {
          output: err?.stderr || err?.message || 'Execution failed',
          runtime: 0
        }
      }
    }

    if (language === 'cpp') {
      try {
        const start = Date.now()

        const { stdout, stderr } = await execa(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '--memory=128m',
            '--cpus=0.5',
            '--pids-limit=64',
            '--network=none',
            'execlab-cpp-runner',
          ],
          {
            input: code,
            timeout: 5000,
          }
        )

        const runtime = Date.now() - start

        return {
          output: stdout || stderr,
          runtime
        }

      } catch (err: any) {
        if (err.timedOut) {
          return { output: 'Execution timed out', runtime: 5000 }
        }

        return {
          output: err?.stderr || err?.message || 'Execution failed',
          runtime: 0
        }
      }
    }

    if (language === 'java') {
      try {
        const start = Date.now()

        const { stdout, stderr } = await execa(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '--memory=128m',
            '--cpus=0.5',
            '--pids-limit=64',
            '--network=none',
            'execlab-java-runner',
          ],
          {
            input: code,
            timeout: 5000,
          }
        )

        const runtime = Date.now() - start

        return {
          output: stdout || stderr,
          runtime
        }

      } catch (err: any) {
        if (err.timedOut) {
          return { output: 'Execution timed out', runtime: 5000 }
        }

        return {
          output: err?.stderr || err?.message || 'Execution failed',
          runtime: 0
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