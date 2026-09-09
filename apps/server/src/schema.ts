import type { SqlClient } from "./db.ts";

/**
 * Idempotent schema bootstrap for self-hosted installations.  This is kept in
 * source (rather than auto-migrating silently in a request) so operators can
 * run it explicitly at startup and inspect the resulting schema.
 */
const statements = [
  `CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
    image TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS account_erasure_pending (
    user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS "session" (
    id TEXT PRIMARY KEY,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    token TEXT NOT NULL UNIQUE,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ,
    "refreshTokenExpiresAt" TIMESTAMPTZ,
    scope TEXT,
    password TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_provider_account_unique ON account ("providerId", "accountId")`,
  `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    created_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    accepted_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS invitations_workspace_idx ON invitations (workspace_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    snapshot JSONB NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('xlsx', 'google', 'demo')),
    source_upload_id TEXT,
    created_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS datasets_workspace_idx ON datasets (workspace_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS dataset_changes (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    entry JSONB NOT NULL,
    record JSONB NOT NULL,
    dataset_revision INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (dataset_id, operation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS dataset_changes_history_idx ON dataset_changes (dataset_id, dataset_revision DESC)`,
  `CREATE TABLE IF NOT EXISTS dataset_operations (
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (dataset_id, operation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    uploader_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_count INTEGER NOT NULL CHECK (byte_count > 0),
    content BYTEA NOT NULL,
    inspection JSONB NOT NULL,
    storage_consent BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS uploads_workspace_idx ON uploads (workspace_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS reimport_previews (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    base_revision INTEGER NOT NULL,
    candidate JSONB,
    changes JSONB NOT NULL,
    conflicts JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS reimport_previews_dataset_idx ON reimport_previews (dataset_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS google_oauth_states (
    state_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS google_credentials (
    user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    encrypted_payload TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS source_operations (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'applying', 'succeeded', 'conflicted', 'failed')),
    preimage JSONB,
    postwrite JSONB,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE (dataset_id, operation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS source_jobs (
    id TEXT PRIMARY KEY,
    sequence BIGSERIAL UNIQUE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('patch', 'create')),
    payload JSONB NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','conflicted','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_token TEXT,
    lease_until TIMESTAMPTZ,
    result JSONB,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE (dataset_id, operation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS source_jobs_pending_idx ON source_jobs (status, next_attempt_at, sequence)`,
  `CREATE TABLE IF NOT EXISTS dataset_versions (
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    snapshot JSONB NOT NULL,
    source_upload_id TEXT REFERENCES uploads(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (dataset_id, revision)
  )`,
  `CREATE OR REPLACE FUNCTION capture_dataset_version() RETURNS trigger AS $$
   BEGIN
     INSERT INTO dataset_versions (dataset_id, revision, snapshot, source_upload_id)
     VALUES (NEW.id, NEW.revision, NEW.snapshot, NEW.source_upload_id)
     ON CONFLICT (dataset_id, revision) DO NOTHING;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS dataset_version_capture ON datasets`,
  `CREATE TRIGGER dataset_version_capture AFTER INSERT OR UPDATE OF revision ON datasets
   FOR EACH ROW EXECUTE FUNCTION capture_dataset_version()`,
  `INSERT INTO dataset_versions (dataset_id, revision, snapshot, source_upload_id)
   SELECT id, revision, snapshot, source_upload_id FROM datasets ON CONFLICT DO NOTHING`,
];

export async function migrate(db: SqlClient): Promise<void> {
  for (const statement of statements) await db.query(statement);
}
