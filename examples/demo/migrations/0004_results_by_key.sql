-- Results were keyed by charge id, which the public ledger table prints. They are keyed by a secret
-- now, handed only to the payer; the charge id is kept so pruning can still find them.
DROP TABLE IF EXISTS demo_results;
CREATE TABLE IF NOT EXISTS demo_results (
  id TEXT PRIMARY KEY,
  charge_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS demo_results_charge_idx ON demo_results (charge_id);
