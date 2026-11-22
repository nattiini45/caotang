CREATE TABLE account_key_records (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  record_json TEXT NOT NULL CHECK (length(record_json) BETWEEN 1 AND 1024)
);
