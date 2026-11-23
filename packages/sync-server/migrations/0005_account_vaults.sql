CREATE TABLE account_vaults (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  vault TEXT NOT NULL CHECK (length(vault) BETWEEN 2 AND 87384),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  updated_at TEXT NOT NULL
);
