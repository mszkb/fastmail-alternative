import type { Migration } from '../migrate'

/**
 * Web Push (roadmap 4.3, ADR-0005):
 * - user.wrapped_dek/key_id: data key per user for user-related secrets
 *   (push subscription keys now, TOTP later), wrapped with the master key
 *   like mail_account.wrapped_dek. Created on first use.
 * - push_subscription.endpoint is unique: the browser reports the same
 *   endpoint again after re-login or permission changes (upsert).
 * - created_at/last_success_at for the device management view.
 */
export const migration0010 = {
  name: '0010_push',
  sql: /* sql */ `
    ALTER TABLE "user" ADD COLUMN wrapped_dek bytea, ADD COLUMN key_id text;

    ALTER TABLE push_subscription
      ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN last_success_at timestamptz;
    CREATE UNIQUE INDEX push_subscription_endpoint_key ON push_subscription (endpoint);
  `,
} satisfies Migration
