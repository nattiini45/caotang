CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY NOT NULL,
  github_id TEXT UNIQUE NOT NULL,
  login TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  session_revision INTEGER NOT NULL DEFAULT 1 CHECK (session_revision BETWEEN 1 AND 9007199254740991),
  quota_limit INTEGER NOT NULL CHECK (quota_limit BETWEEN 1 AND 9007199254740991),
  quota_used INTEGER NOT NULL DEFAULT 0 CHECK (quota_used >= 0),
  quota_reserved INTEGER NOT NULL DEFAULT 0 CHECK (quota_reserved >= 0),
  CHECK (quota_used + quota_reserved <= quota_limit)
);

CREATE TABLE invitations (
  github_id TEXT PRIMARY KEY NOT NULL,
  login TEXT NOT NULL,
  quota_bytes INTEGER NOT NULL CHECK (quota_bytes BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'revoked')),
  account_id TEXT UNIQUE REFERENCES accounts(account_id),
  CHECK (state <> 'pending' OR account_id IS NULL),
  CHECK (state <> 'claimed' OR account_id IS NOT NULL)
);

CREATE TRIGGER revoke_account AFTER UPDATE OF state ON invitations
WHEN NEW.state = 'revoked' AND OLD.state <> 'revoked'
BEGIN
  UPDATE accounts SET status = 'disabled', session_revision = session_revision + 1
  WHERE account_id = NEW.account_id;
END;

CREATE TRIGGER regrant_account AFTER UPDATE OF state ON invitations
WHEN OLD.state = 'revoked' AND NEW.state = 'claimed'
BEGIN
  UPDATE accounts SET status = 'active', session_revision = session_revision + 1
  WHERE account_id = NEW.account_id;
END;
