import { Queue } from 'bullmq'
import { getRedis } from './redis'
const redis = getRedis()

const queue = new Queue('code-execution', {
  connection: redis
})

export default queue