import { pool } from './db'

export const saveSubmission = async ({
  code,
  language,
  output,
  runtime,
}: {
  code: string
  language: string
  output: string
  runtime: number
}) => {
  try {
    await pool.query(
      `INSERT INTO submissions (code, language, output, runtime)
       VALUES ($1, $2, $3, $4)`,
      [code, language, output, runtime]
    )
  } catch (err) {
    console.error('DB save failed:', err)
  }
}