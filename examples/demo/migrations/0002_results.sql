-- Where the demo keeps what a paid call produced, so a retry that lost its response can get it back
-- instead of paying again. Tollstile stores only the reference; the result itself is the merchant's.
CREATE TABLE IF NOT EXISTS demo_results (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
