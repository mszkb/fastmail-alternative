-- Sync progress and cooperative cancellation (#119): folder_sync and
-- message_sync write their phase, the folder (id only) and done/total
-- counters into their job row once per batch (at most every ~2 s);
-- cancel_requested_at asks the running job to stop between batches, after
-- which it ends in the new state 'cancelled'. Only ids and numbers, never
-- folder names or message contents (principles 5/6). The start of a run is
-- the existing locked_at.
--
-- MySQL 8 has no ADD COLUMN IF NOT EXISTS: the ALTER only runs while the
-- columns are missing, so a re-run after a failure is safe.

SET @fma_sync_progress = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE job
       ADD COLUMN progress_phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
       ADD COLUMN progress_folder_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
       ADD COLUMN progress_done INT UNSIGNED NULL,
       ADD COLUMN progress_total INT UNSIGNED NULL,
       ADD COLUMN progress_updated_at DATETIME(6) NULL,
       ADD COLUMN cancel_requested_at DATETIME(6) NULL',
    'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job' AND COLUMN_NAME = 'cancel_requested_at'
);
PREPARE fma_stmt FROM @fma_sync_progress;
EXECUTE fma_stmt;
DEALLOCATE PREPARE fma_stmt;
