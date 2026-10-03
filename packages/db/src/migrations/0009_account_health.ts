import type { Migration } from '../migrate'

/**
 * Account health (roadmap 3.4): the worker records the last connection
 * error of an account as a stable machine code (e.g. AUTH_FAILED,
 * CONNECTION_REFUSED, TIMEOUT) - never server text or content. Together
 * with status/error_count/next_retry_at (migration 0002) this drives the
 * circuit breaker and the status display.
 */
export const migration0009 = {
  name: '0009_account_health',
  sql: /* sql */ `
    ALTER TABLE mail_account ADD COLUMN last_error_code text;
    CREATE INDEX job_account_running_idx ON job (account_id) WHERE state = 'running';
  `,
} satisfies Migration
