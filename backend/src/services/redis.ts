import Redis from 'ioredis'

const redis = new Redis(
  process.env.REDIS_URL || 'redis://localhost:6379',
  {
    maxRetriesPerRequest: null  // required by BullMQ
  }
)

export async function testRedis() {
  await redis.set('test', 'hello')
  return await redis.get('test')
}

export default redis