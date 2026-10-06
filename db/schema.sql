-- SentinelPay schema v1 (Neon / Postgres). Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','revoked')),
  source_text   text NOT NULL,                 -- the natural-language directive
  compiled      jsonb NOT NULL,                -- Policy v1 (validated by zod before insert)
  compiled_hash text NOT NULL,                 -- sha256(canonical(compiled)); confirmation must echo it
  compiler      text NOT NULL,                 -- which model/version produced the candidate
  created_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_by  text,
  confirmed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS policies_owner_idx ON policies(owner_id, status);

-- An ACTIVE policy's compiled body is immutable. Changing limits = new policy + new confirmation.
CREATE OR REPLACE FUNCTION policies_freeze() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.compiled IS DISTINCT FROM OLD.compiled OR NEW.compiled_hash IS DISTINCT FROM OLD.compiled_hash) THEN
    RAISE EXCEPTION 'compiled policy is immutable once confirmed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS policies_freeze_trg ON policies;
CREATE TRIGGER policies_freeze_trg BEFORE UPDATE ON policies FOR EACH ROW EXECUTE FUNCTION policies_freeze();

-- Settled spend, for cumulative_budget rules. Written only on PAYMENT.CAPTURE.COMPLETED.
CREATE TABLE IF NOT EXISTS spend_ledger (
  id         bigserial PRIMARY KEY,
  policy_id  uuid NOT NULL REFERENCES policies(id),
  capture_id text NOT NULL UNIQUE,             -- PayPal capture id: replay-safe
  amount     bigint NOT NULL CHECK (amount >= 0),  -- minor units
  currency   text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS validations (
  id         bigserial PRIMARY KEY,
  policy_id  uuid NOT NULL REFERENCES policies(id),
  cart_id    text NOT NULL,
  decision   text NOT NULL CHECK (decision IN ('ALLOW','DENY','REQUIRE_REAUTH')),
  violations jsonb NOT NULL DEFAULT '[]',
  at         timestamptz NOT NULL DEFAULT now()
);

-- Replay protection: a webhook event id is processed at most once.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id   text PRIMARY KEY,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only, hash-chained audit log.
CREATE TABLE IF NOT EXISTS audit_log (
  seq       bigint PRIMARY KEY,
  prev_hash text NOT NULL,
  hash      text NOT NULL UNIQUE,
  kind      text NOT NULL,
  payload   jsonb NOT NULL,
  at        text NOT NULL                      -- ISO string exactly as hashed
);
CREATE OR REPLACE FUNCTION audit_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_no_mutate ON audit_log;
CREATE TRIGGER audit_no_mutate BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_append_only();
