-- Sort key of the message lists in message_location (load test #60,
-- docs/operations/load-test.md): the lists ordered by
-- COALESCE(m.sent_at, m.received_at, m.created_at) of the joined message,
-- so MySQL/MariaDB had to join and sort every row of the folder for each
-- page (~0.5 s for 50 000 messages on x86). The value never changes after
-- the message is inserted, so it is copied into each location and indexed
-- with the folder: a page is now read in index order.
--
-- The column stays NULL-able: a restore of an older backup fills it
-- afterwards (InstanceBackup::restore). Every step is safe to re-run.

SET @fma_sort_key = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE message_location ADD COLUMN sort_at DATETIME(6) NULL',
    'DO 0')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message_location' AND COLUMN_NAME = 'sort_at'
);
PREPARE fma_stmt FROM @fma_sort_key;
EXECUTE fma_stmt;
DEALLOCATE PREPARE fma_stmt;

UPDATE message_location ml JOIN message m ON m.id = ml.message_id
SET ml.sort_at = COALESCE(m.sent_at, m.received_at, m.created_at)
WHERE ml.sort_at IS NULL;

SET @fma_sort_index = (
  SELECT IF(COUNT(*) = 0,
    'CREATE INDEX message_location_folder_sort_idx ON message_location (folder_id, sort_at, id)',
    'DO 0')
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message_location' AND INDEX_NAME = 'message_location_folder_sort_idx'
);
PREPARE fma_stmt FROM @fma_sort_index;
EXECUTE fma_stmt;
DEALLOCATE PREPARE fma_stmt;
