DROP TRIGGER quota_no_delete;

CREATE TRIGGER quota_prune_guard BEFORE DELETE ON quota_operations
WHEN OLD.state <> 'released' OR OLD.swept_at > (strftime('%s','now') * 1000 - 604800000)
BEGIN
  SELECT RAISE(ABORT, 'Only settled idempotency records past the retention window may be pruned');
END;