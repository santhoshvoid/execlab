import { Worker } from 'bullmq'

const worker = new Worker(
  'code-execution',
  async job => {
    console.log('Processing job:', job.id)

    const { code, language } = job.data

    await new Promise(res => setTimeout(res, 2000))

    console.log(`Executed ${language} code:`, code)

    return { output: 'Execution done' }
  },
  {
    connection: {
      host: 'redis',
      port: 6379
    }
  }
)

console.log('Worker started')