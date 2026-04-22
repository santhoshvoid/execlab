import { Queue } from 'bullmq'
import redis from './redis'


const queue = new Queue('execute', {
  connection: redis
})

export default queue