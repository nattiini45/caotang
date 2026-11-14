CREATE TABLE quota_operations (
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 128),
  bytes INTEGER NOT NULL CHECK (typeof(bytes) = 'integer' AND bytes BETWEEN 0 AND 9007199254740991),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  deadline INTEGER NOT NULL CHECK (typeof(deadline) = 'integer' AND deadline BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'writing', 'committed', 'aborted', 'released')),
  swept_at INTEGER NOT NULL DEFAULT 0 CHECK (typeof(swept_at) = 'integer' AND swept_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (account_id, operation_id),
  UNIQUE (account_id, object_key)
);

CREATE INDEX quota_operations_due ON quota_operations(state, swept_at, deadline);

CREATE TRIGGER quota_reserve BEFORE INSERT ON quota_operations
BEGIN
  SELECT CASE WHEN NEW.state <> 'reserved' OR NOT EXISTS (
    SELECT 1 FROM accounts WHERE account_id = NEW.account_id
    AND status = 'active' AND session_revision = NEW.revision
    AND NEW.bytes <= quota_limit - quota_used - quota_reserved
  ) THEN RAISE(ABORT, 'Quota reservation refused') END;
  UPDATE accounts SET quota_reserved = quota_reserved + NEW.bytes WHERE account_id = NEW.account_id;
END;

CREATE TRIGGER quota_immutable BEFORE UPDATE ON quota_operations
WHEN NEW.account_id <> OLD.account_id OR NEW.operation_id <> OLD.operation_id
  OR NEW.object_key <> OLD.object_key OR NEW.bytes <> OLD.bytes
  OR NEW.revision <> OLD.revision OR NEW.deadline <> OLD.deadline
BEGIN
  SELECT RAISE(ABORT, 'Quota operation is immutable');
END;

CREATE TRIGGER quota_transition BEFORE UPDATE OF state ON quota_operations
WHEN NEW.state <> OLD.state
BEGIN
  SELECT CASE WHEN NOT (
    (OLD.state = 'reserved' AND NEW.state IN ('writing', 'aborted', 'released'))
    OR (OLD.state = 'writing' AND NEW.state IN ('committed', 'aborted'))
    OR (OLD.state = 'aborted' AND NEW.state = 'released')
  ) THEN RAISE(ABORT, 'Quota transition refused') END;
  SELECT CASE WHEN NEW.state IN ('writing', 'committed') AND NOT EXISTS (
    SELECT 1 FROM accounts WHERE account_id = NEW.account_id
    AND status = 'active' AND session_revision = NEW.revision
    AND NEW.bytes <= quota_limit - quota_used
  ) THEN RAISE(ABORT, 'Quota account refused') END;
  UPDATE accounts SET quota_reserved = quota_reserved - OLD.bytes,
    quota_used = quota_used + CASE WHEN NEW.state = 'committed' THEN OLD.bytes ELSE 0 END
  WHERE account_id = OLD.account_id AND NEW.state IN ('committed', 'released');
END;

CREATE TRIGGER quota_no_delete BEFORE DELETE ON quota_operations
BEGIN
  SELECT RAISE(ABORT, 'Quota operations are retained');
END;
