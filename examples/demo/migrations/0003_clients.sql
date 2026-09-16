-- Which MCP clients connect here, and what each says it can do. Names and capabilities only: no
-- user, no content. It answers a question the ecosystem keeps guessing at — who supports what.
CREATE TABLE IF NOT EXISTS demo_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  protocol TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  connections INTEGER NOT NULL
);
