import 'dotenv/config'
import { Worker } from 'bullmq'
import { execa } from 'execa'
import Redis from 'ioredis'
import { saveSubmission } from './services/saveSubmission'
import { io } from './server'
import { spawn } from "child_process"

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
        const start = Date.now()

        const proc = spawn('docker', [
          'run',
          '--rm',
          '-i',
          '--memory=128m',
          '--cpus=0.5',
          '--pids-limit=64',
          '--network=none',
          'execlab-python-runner',
        ])

        // send code
        proc.stdin.write(code)
        proc.stdin.end()

        let finalOutput = ''

        // 🔥 STREAM STDOUT
        proc.stdout.on('data', (chunk) => {
          const text = chunk.toString()
          finalOutput += text

          io.emit(`job:${job.id}`, {
            chunk: text
          })
        })

        // 🔥 STREAM STDERR
        proc.stderr.on('data', (chunk) => {
          const text = chunk.toString()
          finalOutput += text

          io.emit(`job:${job.id}`, {
            chunk: text
          })
        })

        proc.on('close', async () => {
          const runtime = Date.now() - start

          io.emit(`job:${job.id}`, {
            status: "completed",
            output: finalOutput,
            runtime
          })

          await saveSubmission({
            code,
            language,
            output: finalOutput,
            runtime
          })
        })

        return { status: "running" }

      } catch (err: any) {
        return {
          output: err?.message || 'Execution failed',
          runtime: 0
        }
      }
    }

    if (language === 'cpp') {
      try {
        const start = Date.now()

        const subprocess = execa(
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
            timeout: 10000,
          }
        )

        // 🔥 STREAM STDOUT
        subprocess.stdout?.on('data', (chunk) => {
          io.emit(`job:${job.id}`, {
            chunk: chunk.toString(),
            type: "stdout"
          })
        })

        // 🔥 STREAM STDERR
        subprocess.stderr?.on('data', (chunk) => {
          io.emit(`job:${job.id}`, {
            chunk: chunk.toString(),
            type: "stderr"
          })
        })

        // ✅ WAIT FOR PROCESS TO FINISH
        const { stdout, stderr } = await subprocess

        const runtime = Date.now() - start

        const result = {
          output: stdout || stderr,
          runtime,
        }

        // 🔥 REALTIME EMIT (ADD THIS)
        io.emit(`job:${job.id}`, {
          output: result.output,
          runtime: result.runtime,
          status: "completed"
        })

        // 🔥 NON-BLOCKING SAVE
        saveSubmission({
          code,
          language,
          ...result,
        }).catch(err => {
          console.error('DB save failed:', err)
        })

        return result

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

    if (language === 'javascript') {
      try {
        const start = Date.now()

        const proc = spawn('docker', [
          'run',
          '--rm',
          '-i',
          '--memory=128m',
          '--cpus=0.5',
          '--pids-limit=64',
          '--network=none',
          'execlab-node-runner',
        ])

        proc.stdin.write(code)
        proc.stdin.end()

        let finalOutput = ''

        proc.stdout.on('data', (chunk) => {
          const text = chunk.toString()
          finalOutput += text

          io.emit(`job:${job.id}`, {
            chunk: text
          })
        })

        proc.stderr.on('data', (chunk) => {
          const text = chunk.toString()
          finalOutput += text

          io.emit(`job:${job.id}`, {
            chunk: text
          })
        })

        proc.on('close', async () => {
          const runtime = Date.now() - start

          io.emit(`job:${job.id}`, {
            status: "completed",
            output: finalOutput,
            runtime
          })

          await saveSubmission({
            code,
            language,
            output: finalOutput,
            runtime
          })
        })

        return { status: "running" }

      } catch (err: any) {
        return {
          output: err?.message || 'Execution failed',
          runtime: 0
        }
      }
    }

    if (language === 'java') {
      try {
        const start = Date.now()

        const subprocess = execa(
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
            timeout: 10000,
          }
        )

        // 🔥 STREAM STDOUT
        subprocess.stdout?.on('data', (chunk) => {
          io.emit(`job:${job.id}`, {
            chunk: chunk.toString(),
            type: "stdout"
          })
        })

        // 🔥 STREAM STDERR
        subprocess.stderr?.on('data', (chunk) => {
          io.emit(`job:${job.id}`, {
            chunk: chunk.toString(),
            type: "stderr"
          })
        })

        // ✅ WAIT FOR PROCESS TO FINISH
        const { stdout, stderr } = await subprocess

        const runtime = Date.now() - start

        const result = {
          output: stdout || stderr,
          runtime,
        }

        // 🔥 REALTIME EMIT (ADD THIS)
        io.emit(`job:${job.id}`, {
          output: result.output,
          runtime: result.runtime,
          status: "completed"
        })

        // 🔥 NON-BLOCKING SAVE
        saveSubmission({
          code,
          language,
          ...result,
        }).catch(err => {
          console.error('DB save failed:', err)
        })

        return result

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