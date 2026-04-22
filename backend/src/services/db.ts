import { Pool } from 'pg'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
})

export async function testDB() {
  const res = await pool.query('SELECT NOW()')
  return res.rows[0]
}

export default pool