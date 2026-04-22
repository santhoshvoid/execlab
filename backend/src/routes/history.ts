import { FastifyInstance } from 'fastify'
import { pool } from '../services/db'

export async function historyRoutes(app: FastifyInstance) {
  app.get('/history', async () => {
    const res = await pool.query(`
      SELECT * FROM submissions
      ORDER BY created_at DESC
      LIMIT 20
    `)

    return res.rows
  })
}