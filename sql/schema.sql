CREATE TABLE submissions (
  id SERIAL PRIMARY KEY,
  code TEXT,
  language VARCHAR(20),
  output TEXT,
  runtime INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);