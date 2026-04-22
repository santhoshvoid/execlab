import Redis from 'ioredis'

const redis = new Redis({
  host: 'redis',
  port: 6379
})

export async function testRedis() {
  await redis.set('test', 'hello')
  return await redis.get('test')
}

export default redis