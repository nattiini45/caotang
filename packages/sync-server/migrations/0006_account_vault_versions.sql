CREATE TABLE account_vault_versions (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 2147483647)
);

INSERT INTO account_vault_versions (account_id, version) SELECT account_id, version FROM account_vaults;
