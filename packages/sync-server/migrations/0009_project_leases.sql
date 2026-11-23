CREATE TABLE project_leases (
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 64),
  -- The device holding the project, as that device named itself: an opaque label the server never interprets.
  device TEXT NOT NULL CHECK (length(device) BETWEEN 1 AND 64),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, project_id)
);
