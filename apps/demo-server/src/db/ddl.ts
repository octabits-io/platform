/**
 * Boot-time schema creation.
 *
 * A real service would own migrations (`@octabits-io/framework/drizzle/migrate`
 * runs a drizzle-kit migrations folder). A demo that must come up clean against
 * a throwaway container is better served by idempotent DDL, so this runs
 * `CREATE TABLE IF NOT EXISTS` once at startup.
 *
 * `object_storage` is the exception worth noticing: the framework's Postgres
 * blob provider ships its own DDL as `objectStorageDdl()`. We apply it here and
 * boot the provider with `autoCreateTable: false`, so the provider never issues
 * DDL at runtime (its default lazy bootstrap would need DDL privileges on every
 * request path — even a plain read).
 */
import type { Pool } from 'pg';
import { objectStorageDdl } from '@octabits-io/framework/storage/postgres';
import { flowStoreDdl } from '@octabits-io/flow/store-pg';
import type { Logger } from '@octabits-io/framework/logger';

const APP_DDL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    email_encrypted bytea NOT NULL,
    email_index bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS contacts_email_index_idx ON contacts (email_index);

  CREATE TABLE IF NOT EXISTS notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    encrypted boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    updated_by text,
    CONSTRAINT settings_pk PRIMARY KEY (key)
  );

  CREATE TABLE IF NOT EXISTS idempotency_key (
    key text NOT NULL,
    request_hash text NOT NULL,
    response_status smallint NOT NULL,
    response_body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT idempotency_key_pk PRIMARY KEY (key)
  );
  CREATE INDEX IF NOT EXISTS idempotency_key_expires_at_idx ON idempotency_key (expires_at);

  -- Consumer side of flow's AI usage/quota seams (src/ai/usage.ts). The
  -- flow_workflow/flow_workflow_step tables themselves come from flowStoreDdl()
  -- below — flow owns that DDL the same way objectStorageDdl() owns its table.
  CREATE TABLE IF NOT EXISTS ai_step_usage (
    step_id bigint PRIMARY KEY,
    workflow_id bigint NOT NULL,
    model_id text NOT NULL DEFAULT '',
    input_tokens integer NOT NULL DEFAULT 0,
    output_tokens integer NOT NULL DEFAULT 0,
    cache_read_tokens integer NOT NULL DEFAULT 0,
    cache_write_tokens integer NOT NULL DEFAULT 0,
    cost_micros bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS ai_workflow_usage (
    workflow_id bigint PRIMARY KEY,
    input_tokens bigint NOT NULL DEFAULT 0,
    output_tokens bigint NOT NULL DEFAULT 0,
    cache_read_tokens bigint NOT NULL DEFAULT 0,
    cache_write_tokens bigint NOT NULL DEFAULT 0,
    cost_micros bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS ai_usage_daily (
    partition_key text NOT NULL,
    usage_date date NOT NULL,
    workflow_type text NOT NULL,
    key_source text NOT NULL,
    workflow_count integer NOT NULL DEFAULT 0,
    input_tokens bigint NOT NULL DEFAULT 0,
    output_tokens bigint NOT NULL DEFAULT 0,
    cache_read_tokens bigint NOT NULL DEFAULT 0,
    cache_write_tokens bigint NOT NULL DEFAULT 0,
    estimated_cost_micros bigint NOT NULL DEFAULT 0,
    CONSTRAINT ai_usage_daily_pk PRIMARY KEY (partition_key, usage_date, workflow_type, key_source)
  );

  CREATE TABLE IF NOT EXISTS job_audit_log (
    id bigserial PRIMARY KEY,
    job_id text NOT NULL,
    queue_name text NOT NULL,
    job_type text NOT NULL,
    status text NOT NULL,
    payload jsonb,
    error_message text,
    attempt_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
  );
`;

/** Create every table this app needs. Idempotent — safe on every boot. */
export async function ensureSchema(pool: Pool, logger: Logger): Promise<void> {
  await pool.query(APP_DDL);
  await pool.query(objectStorageDdl());
  await pool.query(flowStoreDdl());
  logger.info('Schema ensured');
}
