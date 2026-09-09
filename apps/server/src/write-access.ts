import type { Role } from "../../../packages/core/src/index.ts";
import { inTransaction, type SqlClient } from "./db.ts";
import { forbidden, HttpError, unauthorized } from "./errors.ts";

/**
 * Mutations lock the actor before any workspace/dataset. Account erasure uses
 * this same ordering and leaves a marker through Better Auth's separate DELETE.
 * A request authenticated earlier must not recreate attribution after cleanup.
 */
export async function lockActiveActor(
  tx: SqlClient,
  userId: string,
): Promise<void> {
  const user = await tx.query(
    'SELECT id FROM "user" WHERE id = $1 FOR UPDATE',
    [userId],
  );
  if (!user.rows.length) throw unauthorized();
  const pending = await tx.query(
    "SELECT user_id FROM account_erasure_pending WHERE user_id = $1",
    [userId],
  );
  if (pending.rows.length)
    throw new HttpError(
      409,
      "ACCOUNT_ERASURE_PENDING",
      "Account deletion is in progress. New changes are blocked.",
    );
}

/** Call after lockActiveActor, inside the same transaction as the mutation. */
export async function lockWorkspaceAccess(
  tx: SqlClient,
  workspaceId: string,
  userId: string,
  write = true,
  ownerOnly = false,
): Promise<Role> {
  const workspace = await tx.query(
    "SELECT id FROM workspaces WHERE id = $1 FOR SHARE",
    [workspaceId],
  );
  if (!workspace.rows.length) throw forbidden();
  const membership = await tx.query<{ role: Role }>(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  const role = membership.rows[0]?.role;
  if (!role || (write && role === "viewer") || (ownerOnly && role !== "owner"))
    throw forbidden();
  return role;
}

export async function withActorTransaction<T>(
  db: SqlClient,
  userId: string,
  work: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  return inTransaction(db, async (tx) => {
    await lockActiveActor(tx, userId);
    return work(tx);
  });
}
