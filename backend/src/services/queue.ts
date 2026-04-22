import { Queue } from 'bullmq'
import redis from './redis'

const queue = new Queue('code-execution', {
  connection: redis
})

export default queue