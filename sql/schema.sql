CREATE TABLE IF NOT EXISTS submissions (
    id SERIAL PRIMARY KEY,
    language TEXT,
    code TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);