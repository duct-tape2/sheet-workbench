import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Dataset, Role } from "../../../packages/core/src/index.ts";
import type { SessionUser } from "./auth.ts";
import { asJson, inTransaction, parseJson, type SqlClient } from "./db.ts";
import { forbidden, HttpError, setupNeeded } from "./errors.ts";
import { lockActiveActor } from "./write-access.ts";

export const DELETED_ACTOR_ID = "deleted-account";
const DELETED_ACTOR_EMAIL = "deleted-account@invalid.local";
const DELETED_ACTOR_NAME = "Deleted account";

const memberRole = z.enum(["owner", "editor", "viewer"]);
const confirmation = z.string().min(1).max(254);

export interface AdministrationDependencies {
  currentUser(request: FastifyRequest): Promise<SessionUser>;
  workspaceAccess(
    request: FastifyRequest,
    workspaceId: string,
    write?: boolean,
    ownerOnly?: boolean,
  ): Promise<{ user: SessionUser; role: Role }>;
  /**
   * Better Auth owns sensitive-session and password verification. The server
   * supplies this closure so these routes never reimplement authentication.
   */
  deleteCurrentAccount?(
    request: FastifyRequest,
    password: string | undefined,
  ): Promise<unknown>;
  /** Notify live dataset clients only after a successful administration write. */
  emitDataset?(datasetId: string, payload: unknown): void;
  /** Optional hook for hosts that keep per-workspace ephemeral state. */
  emitWorkspace?(workspaceId: string, payload: unknown): void;
}

interface WorkspaceRow {
  id: string;
  name: string;
}

interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: Role;
}

interface DatasetRow {
  id: string;
  snapshot: unknown;
  revision: number;
  source_kind: Dataset["source"]["kind"];
  source_upload_id: string | null;
}
interface DatasetVersionRow {
  dataset_id: string;
  revision: number;
  snapshot: unknown;
}

function requestParams(request: FastifyRequest): Record<string, string> {
  return request.params as Record<string, string>;
}

function requestBody<T>(request: FastifyRequest, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success)
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      "Request body is invalid.",
      parsed.error.flatten(),
    );
  return parsed.data;
}

function notFound(code: string, message: string): HttpError {
  return new HttpError(404, code, message);
}

function lastOwnerError(): HttpError {
  return new HttpError(
    409,
    "LAST_OWNER",
    "A workspace must retain at least one owner.",
  );
}

async function relationExists(
  sql: SqlClient,
  relation: string,
): Promise<boolean> {
  const result = await sql.query<{ relation: string | null }>(
    "SELECT to_regclass($1::text)::text AS relation",
    [relation],
  );
  return Boolean(result.rows[0]?.relation);
}

async function lockOwner(
  sql: SqlClient,
  workspaceId: string,
  user: SessionUser,
): Promise<SessionUser> {
  // Authentication was resolved before acquiring this transaction's pool
  // connection. Re-entering Better Auth here can deadlock a saturated pool.
  // Authorization still uses the locked, current database membership below.
  await lockActiveActor(sql, user.id);
  const workspace = await sql.query<WorkspaceRow>(
    "SELECT id, name FROM workspaces WHERE id = $1 FOR UPDATE",
    [workspaceId],
  );
  if (!workspace.rows[0])
    throw notFound("WORKSPACE_NOT_FOUND", "Workspace was not found.");
  const membership = await sql.query<{ role: Role }>(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
    [workspaceId, user.id],
  );
  if (membership.rows[0]?.role !== "owner") throw forbidden();
  return user;
}

async function lockedOwnerIds(
  sql: SqlClient,
  workspaceId: string,
): Promise<string[]> {
  const owners = await sql.query<{ user_id: string }>(
    "SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' FOR UPDATE",
    [workspaceId],
  );
  return owners.rows.map((owner) => owner.user_id);
}

async function accountProfile(
  sql: SqlClient,
  userId: string,
): Promise<{ name: string; email: string }> {
  const result = await sql.query<{ name: string; email: string }>(
    'SELECT name, email FROM "user" WHERE id = $1',
    [userId],
  );
  const profile = result.rows[0];
  if (!profile)
    throw new HttpError(401, "UNAUTHENTICATED", "Sign in is required.");
  return profile;
}

async function ensureDeletedActor(sql: SqlClient): Promise<void> {
  await sql.query(
    `INSERT INTO "user" (id, name, email, "emailVerified")
     VALUES ($1, $2, $3, FALSE)
     ON CONFLICT (id) DO NOTHING`,
    [DELETED_ACTOR_ID, DELETED_ACTOR_NAME, DELETED_ACTOR_EMAIL],
  );
}

function disconnectedGoogleSource(
  source: Dataset["source"] & {
    connectedBy?: string;
    readOnly?: boolean;
    readOnlyReason?: string;
  },
  userId: string,
): Dataset["source"] | undefined {
  if (source.kind !== "google" || source.connectedBy !== userId)
    return undefined;
  const { connectedBy: _connectedBy, ...disconnectedSource } = source;
  return {
    ...disconnectedSource,
    readOnly: true,
    readOnlyReason:
      "Google connection was disconnected because its connected account was deleted.",
  };
}

function scrubGoogleSource(
  snapshot: Dataset,
  userId: string,
): Dataset | undefined {
  const source = snapshot.source as Dataset["source"] & {
    connectedBy?: string;
    readOnly?: boolean;
    readOnlyReason?: string;
  };
  const disconnectedSource = disconnectedGoogleSource(source, userId);
  if (!disconnectedSource) return undefined;
  return {
    ...snapshot,
    source: disconnectedSource,
    revision: snapshot.revision + 1,
    updatedAt: new Date().toISOString(),
  };
}

async function workspaceIdsForAccountErasure(
  sql: SqlClient,
  userId: string,
  hasSourceJobs: boolean,
  hasDatasetVersions: boolean,
): Promise<string[]> {
  const ids = new Set<string>();
  const add = (rows: Array<{ workspace_id: string }>) => {
    for (const row of rows) ids.add(row.workspace_id);
  };
  add(
    (
      await sql.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM workspace_members WHERE user_id = $1",
        [userId],
      )
    ).rows,
  );
  // A collaborator may already have been removed from a workspace while an
  // historical Google snapshot still retains the credential identity. Include
  // that workspace as well so erasure does not leave a stale `connectedBy`.
  if (hasDatasetVersions)
    add(
      (
        await sql.query<{ workspace_id: string }>(
          `SELECT DISTINCT d.workspace_id
           FROM dataset_versions v
           JOIN datasets d ON d.id = v.dataset_id
           WHERE v.snapshot->'source'->>'connectedBy' = $1`,
          [userId],
        )
      ).rows,
    );
  add(
    (
      await sql.query<{ workspace_id: string }>(
        "SELECT id AS workspace_id FROM workspaces WHERE created_by = $1",
        [userId],
      )
    ).rows,
  );
  add(
    (
      await sql.query<{ workspace_id: string }>(
        "SELECT DISTINCT workspace_id FROM datasets WHERE created_by = $1 OR snapshot->'source'->>'connectedBy' = $2",
        [userId, userId],
      )
    ).rows,
  );
  if (hasSourceJobs)
    add(
      (
        await sql.query<{ workspace_id: string }>(
          "SELECT DISTINCT workspace_id FROM source_jobs WHERE actor_id = $1",
          [userId],
        )
      ).rows,
    );
  return [...ids].sort();
}

/**
 * Prepare an account for Better Auth's hard delete. This intentionally retains
 * team-owned record values, but removes the account's membership, queued or
 * historical job payloads, and personally identifying attribution.
 *
 * Better Auth invokes this from its `beforeDelete` hook, immediately before it
 * deletes the auth user and cascades sessions/accounts. Every workspace is
 * locked before its jobs or datasets so source workers holding a shared
 * workspace lock cannot write after membership removal.
 */
export async function prepareAccountErasure(
  db: SqlClient,
  userId: string,
  emitDataset?: AdministrationDependencies["emitDataset"],
): Promise<void> {
  const changedDatasets: string[] = [];
  await inTransaction(db, async (tx) => {
    // Unlike normal writes this path accepts an existing pending marker so a
    // failed auth DELETE can be retried. Lock the actor BEFORE every workspace.
    await tx.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [userId]);
    const profile = await accountProfile(tx, userId);
    await tx.query(
      "INSERT INTO account_erasure_pending (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [userId],
    );
    const hasSourceJobs = await relationExists(tx, "source_jobs");
    const hasDatasetVersions = await relationExists(tx, "dataset_versions");
    const workspaceIds = await workspaceIdsForAccountErasure(
      tx,
      userId,
      hasSourceJobs,
      hasDatasetVersions,
    );

    // Lock a stable, complete workspace set before mutating membership, jobs,
    // or datasets. The worker contract uses the same workspace lock first.
    for (const workspaceId of workspaceIds) {
      const workspace = await tx.query<WorkspaceRow>(
        "SELECT id, name FROM workspaces WHERE id = $1 FOR UPDATE",
        [workspaceId],
      );
      if (!workspace.rows[0]) continue;
      const membership = await tx.query<{ role: Role }>(
        "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
        [workspaceId, userId],
      );
      if (membership.rows[0]?.role === "owner") {
        const owners = await lockedOwnerIds(tx, workspaceId);
        if (owners.length <= 1)
          throw new HttpError(
            409,
            "ACCOUNT_HAS_SOLE_OWNER_WORKSPACE",
            `Transfer ownership of "${workspace.rows[0].name}" before deleting this account.`,
          );
      }

      // Job payloads can contain user-authored source-write data. Remove every
      // job owned by this account, not only queued rows, once the workspace
      // lock proves no writer can start or remain active through this deletion.
      if (hasSourceJobs)
        await tx.query(
          "DELETE FROM source_jobs WHERE workspace_id = $1 AND actor_id = $2",
          [workspaceId, userId],
        );

      const datasets = await tx.query<DatasetRow>(
        "SELECT id, snapshot, revision, source_kind, source_upload_id FROM datasets WHERE workspace_id = $1 FOR UPDATE",
        [workspaceId],
      );
      for (const row of datasets.rows) {
        const snapshot = parseJson<Dataset>(row.snapshot);
        const disconnected = scrubGoogleSource(snapshot, userId);
        if (disconnected) {
          if (disconnected.revision !== Number(row.revision) + 1)
            throw new HttpError(
              500,
              "DATASET_CORRUPT",
              "Stored dataset revision is inconsistent.",
            );
          await tx.query(
            "UPDATE datasets SET snapshot = $1, revision = $2, updated_at = NOW() WHERE id = $3 AND revision = $4",
            [asJson(disconnected), disconnected.revision, row.id, row.revision],
          );
          changedDatasets.push(row.id);
        }

        // Historical revisions can retain connectedBy even after the current
        // snapshot is scrubbed. Keep their recorded content/revision intact,
        // but disconnect the deleted account's credential identity there too.
        if (hasDatasetVersions) {
          const versions = await tx.query<DatasetVersionRow>(
            "SELECT dataset_id, revision, snapshot FROM dataset_versions WHERE dataset_id = $1 FOR UPDATE",
            [row.id],
          );
          for (const version of versions.rows) {
            const versionSnapshot = parseJson<Dataset>(version.snapshot);
            const versionSource = disconnectedGoogleSource(
              versionSnapshot.source as Dataset["source"] & {
                connectedBy?: string;
                readOnly?: boolean;
                readOnlyReason?: string;
              },
              userId,
            );
            if (!versionSource) continue;
            await tx.query(
              "UPDATE dataset_versions SET snapshot = $1 WHERE dataset_id = $2 AND revision = $3",
              [
                asJson({ ...versionSnapshot, source: versionSource }),
                version.dataset_id,
                version.revision,
              ],
            );
          }
        }
      }
      if (membership.rows[0])
        await tx.query(
          "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
          [workspaceId, userId],
        );
    }

    await ensureDeletedActor(tx);
    // Preserve the datasets and their team-authored content while ensuring no
    // historical FK or visible author field points back to the deleted person.
    await tx.query(
      "UPDATE workspaces SET created_by = $1 WHERE created_by = $2",
      [DELETED_ACTOR_ID, userId],
    );
    await tx.query(
      "UPDATE datasets SET created_by = $1 WHERE created_by = $2",
      [DELETED_ACTOR_ID, userId],
    );
    await tx.query(
      "UPDATE invitations SET invited_by = $1 WHERE invited_by = $2",
      [DELETED_ACTOR_ID, userId],
    );
    await tx.query(
      `UPDATE dataset_changes
       SET actor_id = $1,
           entry = CASE
             WHEN jsonb_typeof(entry) = 'object'
               THEN jsonb_set(entry, '{actor}', to_jsonb($3::text), TRUE)
             ELSE entry
           END
       WHERE actor_id = $2`,
      [DELETED_ACTOR_ID, userId, DELETED_ACTOR_NAME],
    );
    await tx.query(
      "UPDATE dataset_operations SET actor_id = $1 WHERE actor_id = $2",
      [DELETED_ACTOR_ID, userId],
    );
    await tx.query(
      "UPDATE uploads SET uploader_id = $1 WHERE uploader_id = $2",
      [DELETED_ACTOR_ID, userId],
    );
    await tx.query(
      "UPDATE source_operations SET actor_id = $1 WHERE actor_id = $2",
      [DELETED_ACTOR_ID, userId],
    );
    // Better Auth stores reset/delete verification values without a user FK.
    // Clear both id-backed values and the prior email identifier before the
    // auth row is removed, so no credential-bearing token survives erasure.
    await tx.query(
      "DELETE FROM verification WHERE value = $1 OR identifier = $2",
      [userId, profile.email],
    );
  });
  for (const datasetId of changedDatasets)
    emitDataset?.(datasetId, { type: "account-erasure-disconnected-source" });
}

async function accountDeletionStatus(
  db: SqlClient,
  userId: string,
): Promise<{
  canDelete: boolean;
  blockedWorkspaces: Array<{ id: string; name: string }>;
}> {
  const result = await db.query<{
    id: string;
    name: string;
    owner_count: number;
  }>(
    `SELECT w.id, w.name,
            (SELECT COUNT(*) FROM workspace_members owners
             WHERE owners.workspace_id = w.id AND owners.role = 'owner') AS owner_count
     FROM workspaces w
     JOIN workspace_members mine ON mine.workspace_id = w.id
     WHERE mine.user_id = $1 AND mine.role = 'owner'
     ORDER BY w.created_at ASC`,
    [userId],
  );
  const blockedWorkspaces = result.rows
    .filter((workspace) => Number(workspace.owner_count) <= 1)
    .map(({ id, name }) => ({ id, name }));
  return { canDelete: blockedWorkspaces.length === 0, blockedWorkspaces };
}

async function deleteUnusedSourceUpload(
  tx: SqlClient,
  workspaceId: string,
  uploadId: string,
): Promise<boolean> {
  const referencedByDataset = await tx.query<{ id: string }>(
    "SELECT id FROM datasets WHERE source_upload_id = $1 LIMIT 1",
    [uploadId],
  );
  if (referencedByDataset.rows[0]) return false;
  if (await relationExists(tx, "dataset_versions")) {
    const referencedByVersion = await tx.query<{ dataset_id: string }>(
      "SELECT dataset_id FROM dataset_versions WHERE source_upload_id = $1 LIMIT 1",
      [uploadId],
    );
    if (referencedByVersion.rows[0]) return false;
  }
  const removed = await tx.query(
    "DELETE FROM uploads WHERE id = $1 AND workspace_id = $2",
    [uploadId, workspaceId],
  );
  return removed.rowCount === 1;
}

/** Register workspace administration and account erasure routes. */
export function registerAdministration(
  app: FastifyInstance,
  db: SqlClient,
  context: AdministrationDependencies,
): void {
  app.get("/api/workspaces/:wid/members", async (request) => {
    const { wid } = requestParams(request);
    await context.workspaceAccess(request, wid, false, true);
    const members = await db.query<MemberRow>(
      `SELECT u.id, u.name, u.email, m.role
       FROM workspace_members m
       JOIN "user" u ON u.id = m.user_id
       WHERE m.workspace_id = $1
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                u.name ASC, u.email ASC`,
      [wid],
    );
    return members.rows;
  });

  app.patch("/api/workspaces/:wid/members/:uid", async (request) => {
    const { wid, uid } = requestParams(request);
    const body = requestBody(request, z.object({ role: memberRole }).strict());
    const access = await context.workspaceAccess(request, wid, true, true);
    const member = await inTransaction(db, async (tx) => {
      await lockOwner(tx, wid, access.user);
      const target = await tx.query<MemberRow>(
        `SELECT u.id, u.name, u.email, m.role
         FROM workspace_members m JOIN "user" u ON u.id = m.user_id
         WHERE m.workspace_id = $1 AND m.user_id = $2 FOR UPDATE OF m`,
        [wid, uid],
      );
      const existing = target.rows[0];
      if (!existing)
        throw notFound("MEMBER_NOT_FOUND", "Workspace member was not found.");
      if (existing.role === "owner" && body.role !== "owner") {
        const owners = await lockedOwnerIds(tx, wid);
        if (owners.length <= 1) throw lastOwnerError();
      }
      if (existing.role !== body.role)
        await tx.query(
          "UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2",
          [wid, uid, body.role],
        );
      return { ...existing, role: body.role };
    });
    context.emitWorkspace?.(wid, { type: "member-role-changed", userId: uid });
    return member;
  });

  app.delete("/api/workspaces/:wid/members/:uid", async (request) => {
    const { wid, uid } = requestParams(request);
    const access = await context.workspaceAccess(request, wid, true, true);
    await inTransaction(db, async (tx) => {
      await lockOwner(tx, wid, access.user);
      const target = await tx.query<{ role: Role }>(
        "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
        [wid, uid],
      );
      const existing = target.rows[0];
      if (!existing)
        throw notFound("MEMBER_NOT_FOUND", "Workspace member was not found.");
      if (
        existing.role === "owner" &&
        (await lockedOwnerIds(tx, wid)).length <= 1
      )
        throw lastOwnerError();
      const removed = await tx.query(
        "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [wid, uid],
      );
      if (removed.rowCount !== 1)
        throw new HttpError(
          409,
          "CONFLICT",
          "Membership changed while removing it.",
        );
    });
    context.emitWorkspace?.(wid, { type: "member-removed", userId: uid });
    return { deleted: true };
  });

  app.delete("/api/workspaces/:wid/datasets/:did", async (request) => {
    const { wid, did } = requestParams(request);
    const body = requestBody(
      request,
      z.object({ confirmName: confirmation }).strict(),
    );
    const access = await context.workspaceAccess(request, wid, true, true);
    const deleted = await inTransaction(db, async (tx) => {
      await lockOwner(tx, wid, access.user);
      const found = await tx.query<DatasetRow>(
        "SELECT id, snapshot, revision, source_kind, source_upload_id FROM datasets WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [did, wid],
      );
      const row = found.rows[0];
      if (!row) throw notFound("DATASET_NOT_FOUND", "Dataset was not found.");
      const snapshot = parseJson<Dataset>(row.snapshot);
      if (body.confirmName !== snapshot.name)
        throw new HttpError(
          400,
          "CONFIRMATION_MISMATCH",
          "Enter the exact dataset name to delete it.",
        );
      // A re-import can leave prior original XLSX uploads attached only to
      // historical revisions. Capture every local reference before the
      // dataset cascade removes those version rows, then remove each upload
      // only if no other dataset or surviving version still points to it.
      const sourceUploadIds = new Set<string>();
      if (row.source_upload_id) sourceUploadIds.add(row.source_upload_id);
      if (await relationExists(tx, "dataset_versions")) {
        const versions = await tx.query<{ source_upload_id: string | null }>(
          "SELECT source_upload_id FROM dataset_versions WHERE dataset_id = $1 FOR UPDATE",
          [did],
        );
        for (const version of versions.rows)
          if (version.source_upload_id)
            sourceUploadIds.add(version.source_upload_id);
      }
      const removed = await tx.query(
        "DELETE FROM datasets WHERE id = $1 AND workspace_id = $2",
        [did, wid],
      );
      if (removed.rowCount !== 1)
        throw new HttpError(
          409,
          "CONFLICT",
          "Dataset changed while deletion was being confirmed.",
        );
      let sourceUploadRemoved = false;
      for (const uploadId of sourceUploadIds)
        if (await deleteUnusedSourceUpload(tx, wid, uploadId))
          sourceUploadRemoved = true;
      return { sourceUploadRemoved };
    });
    context.emitDataset?.(did, { type: "dataset-deleted" });
    return { deleted: true, ...deleted };
  });

  app.get("/api/account/deletion-status", async (request) => {
    const user = await context.currentUser(request);
    return accountDeletionStatus(db, user.id);
  });

  app.post("/api/account/delete", async (request) => {
    const user = await context.currentUser(request);
    const body = requestBody(
      request,
      z
        .object({
          confirmName: confirmation,
          confirmEmail: confirmation,
          password: z.string().min(1).max(1024).optional(),
        })
        .strict(),
    );
    const profile = await accountProfile(db, user.id);
    if (
      body.confirmName !== profile.name ||
      body.confirmEmail !== profile.email
    )
      throw new HttpError(
        400,
        "CONFIRMATION_MISMATCH",
        "Enter your exact account name and email to delete the account.",
      );
    if (!context.deleteCurrentAccount)
      throw setupNeeded("Account deletion requires configured authentication.");
    try {
      return await context.deleteCurrentAccount(request, body.password);
    } catch (error) {
      // The injected Better Auth API uses an APIError for a wrong password or
      // a non-fresh session. Translate that boundary to our normal HTTP error
      // shape without trying to verify credentials ourselves. Importantly its
      // error is raised before Better Auth calls `beforeDelete`, so this path
      // cannot have run account erasure.
      const authError = error as {
        name?: unknown;
        statusCode?: unknown;
      };
      if (authError?.name === "APIError") {
        const status =
          typeof authError.statusCode === "number" &&
          authError.statusCode >= 400 &&
          authError.statusCode < 500
            ? authError.statusCode
            : 400;
        throw new HttpError(
          status,
          "ACCOUNT_DELETE_REAUTH_REQUIRED",
          "Account deletion needs your current password or a fresh sign-in session.",
        );
      }
      throw error;
    }
  });
}
