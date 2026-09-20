-- How many paid research calls used the AI gateway today. The demo pays for those with a real
-- key, and the test rail makes calling free, so the Worker keeps its own ceiling per day.
CREATE TABLE IF NOT EXISTS demo_gateway_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL
);
