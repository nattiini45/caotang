CREATE TABLE project_records (
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 64),
  -- base64 of the project key wrapped under the account's master key (61 bytes sealed): opaque to the server.
  wrapped_key TEXT NOT NULL CHECK (length(wrapped_key) = 84),
  -- base64 of the sealed project record (its name): opaque to the server, at most 1024 sealed bytes.
  record TEXT NOT NULL CHECK (length(record) BETWEEN 4 AND 1368),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, project_id)
);
