import Redis from 'ioredis'

let redis: Redis | null = null

export function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      lazyConnect: true,   // 🔥 ADD THIS
    })

    redis.on('error', () => {}) // 🔥 silence logs
  }
  return redis
}