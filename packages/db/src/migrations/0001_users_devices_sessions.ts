import type { Migration } from '../migrate'

/** Users, devices, sessions, push subscriptions (ADR-0004, roadmap 1.4/1.6). */
export const migration0001 = {
  name: '0001_users_devices_sessions',
  sql: /* sql */ `
    CREATE EXTENSION IF NOT EXISTS citext;

    CREATE TABLE "user" (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email                  citext NOT NULL UNIQUE,
      password_hash          text NOT NULL,
      totp_secret_enc        bytea,
      unified_inbox_enabled  boolean NOT NULL DEFAULT false,
      created_at             timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE device (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id          uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      name             text NOT NULL,
      platform         text NOT NULL,
      installation_id  uuid NOT NULL UNIQUE,
      last_seen_at     timestamptz,
      revoked_at       timestamptz
    );

    CREATE TABLE session (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id   uuid NOT NULL REFERENCES device (id) ON DELETE CASCADE,
      token_hash  bytea NOT NULL UNIQUE,
      expires_at  timestamptz NOT NULL,
      rotated_at  timestamptz
    );
    CREATE INDEX session_expires_at_idx ON session (expires_at);

    CREATE TABLE push_subscription (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id       uuid NOT NULL REFERENCES device (id) ON DELETE CASCADE,
      transport       text NOT NULL,
      endpoint        text NOT NULL,
      keys_enc        bytea NOT NULL,
      failure_count   integer NOT NULL DEFAULT 0,
      disabled_at     timestamptz
    );
    CREATE INDEX push_subscription_active_idx
      ON push_subscription (device_id) WHERE disabled_at IS NULL;
  `,
} satisfies Migration
