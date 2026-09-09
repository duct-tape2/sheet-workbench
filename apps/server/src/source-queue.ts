import { createHash, randomUUID } from "node:crypto";
import { asJson, inTransaction, parseJson, type SqlClient } from "./db.ts";
import { conflict, forbidden, HttpError } from "./errors.ts";
import { lockActiveActor } from "./write-access.ts";

export interface SourceJob {
  id: string;
  workspace_id: string;
  dataset_id: string;
  actor_id: string;
  operation_id: string;
  kind: "patch" | "create";
  payload: unknown;
  status: "queued" | "running" | "succeeded" | "conflicted" | "failed";
  attempts: number;
  lease_token?: string;
  result?: unknown;
  error_code?: string;
  error_message?: string;
}
export interface QueueOptions {
  /**
   * Resolve network/database-backed dependencies before taking the job and
   * dataset locks. Prepared values are process-local and are never persisted
   * with the job payload.
   */
  prepare?: (job: SourceJob) => Promise<unknown>;
  execute: (job: SourceJob, tx: SqlClient, prepared?: unknown) => Promise<unknown>;
  committed?: (job: SourceJob, result: unknown) => void;
  failed?: (job: SourceJob, error: unknown, retry: boolean) => Promise<void>;
  intervalMs?: number;
  retryBaseMs?: number;
  maxAttempts?: number;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function transientSourceError(error: unknown): boolean {
  if (error instanceof HttpError)
    return (
      !/CONFIGURATION|RECONNECT|READ_ONLY|UNSAFE|CONFLICT|POSTWRITE|UNCERTAIN/.test(
        error.code,
      ) &&
      (error.statusCode === 408 ||
        error.statusCode === 429 ||
        error.statusCode >= 500)
    );
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      (error instanceof TypeError && /fetch|network/i.test(error.message)))
  );
}

/** Persistent, per-dataset FIFO. A retry always revalidates source identity and outcome. */
export class SourceQueue {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  constructor(
    private db: SqlClient,
    private options: QueueOptions,
  ) {}

  async enqueue(
    input: Pick<
      SourceJob,
      | "workspace_id"
      | "dataset_id"
      | "actor_id"
      | "operation_id"
      | "kind"
      | "payload"
    >,
    sql: SqlClient = this.db,
  ): Promise<SourceJob> {
    const fingerprint = createHash("sha256")
      .update(canonical({ kind: input.kind, payload: input.payload }))
      .digest("hex");
    await sql.query(
      `INSERT INTO source_jobs (id,workspace_id,dataset_id,actor_id,operation_id,kind,payload,fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dataset_id,operation_id) DO NOTHING`,
      [
        randomUUID(),
        input.workspace_id,
        input.dataset_id,
        input.actor_id,
        input.operation_id,
        input.kind,
        asJson(input.payload),
        fingerprint,
      ],
    );
    const result = await sql.query<SourceJob & { fingerprint: string }>(
      "SELECT * FROM source_jobs WHERE dataset_id=$1 AND operation_id=$2",
      [input.dataset_id, input.operation_id],
    );
    const job = result.rows[0];
    if (
      !job ||
      job.actor_id !== input.actor_id ||
      job.fingerprint !== fingerprint
    )
      throw conflict(
        "This operation ID is already bound to a different request.",
      );
    return {
      ...job,
      payload: parseJson(job.payload),
      result: job.result ? parseJson(job.result) : undefined,
    };
  }

  async run(id: string): Promise<SourceJob | undefined> {
    const token = randomUUID();
    const claimed = await this.db.query<SourceJob>(
      `UPDATE source_jobs j SET status='running', attempts=attempts+1, lease_token=$2,
         lease_until=NOW()+INTERVAL '2 minutes', error_code=NULL, error_message=NULL
       WHERE j.id=$1 AND ((j.status='queued' AND j.next_attempt_at<=NOW()) OR (j.status='running' AND j.lease_until<NOW()))
       AND NOT EXISTS (SELECT 1 FROM source_jobs older WHERE older.dataset_id=j.dataset_id AND older.sequence<j.sequence AND older.status IN ('queued','running'))
       RETURNING j.*`,
      [id, token],
    );
    const job = claimed.rows[0];
    if (!job) return this.get(id);
    job.payload = parseJson(job.payload);
    try {
      // OAuth refreshes use the pool too. Do them before `inTransaction()` so
      // a pool of one cannot wait on the client held by the source transaction.
      const prepared = await this.options.prepare?.(job);
      const result = await inTransaction(this.db, async (tx) => {
        // Account erasure takes this same lock before deleting attribution.
        // It must precede workspace/dataset locks to keep the lock graph flat.
        await lockActiveActor(tx, job.actor_id);
        // Administrative changes lock this row FOR UPDATE. Once that commits,
        // revoked members cannot start another source write.
        const workspace = await tx.query(
          "SELECT id FROM workspaces WHERE id=$1 FOR SHARE",
          [job.workspace_id],
        );
        if (!workspace.rows.length) throw forbidden();
        const locked = await tx.query<SourceJob>(
          "SELECT * FROM source_jobs WHERE id=$1 FOR UPDATE",
          [id],
        );
        if (!locked.rows[0] || locked.rows[0].lease_token !== token)
          throw conflict("The source request lease is no longer active.");
        const membership = await tx.query<{ role: string }>(
          "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
          [job.workspace_id, job.actor_id],
        );
        if (!membership.rows[0] || membership.rows[0].role === "viewer")
          throw forbidden("Source editing permission was revoked.");
        const output =
          prepared === undefined
            ? await this.options.execute(job, tx)
            : await this.options.execute(job, tx, prepared);
        await tx.query(
          "UPDATE source_jobs SET status='succeeded', result=$2, completed_at=NOW(), lease_token=NULL, lease_until=NULL WHERE id=$1 AND lease_token=$3",
          [id, asJson(output), token],
        );
        return output;
      });
      this.options.committed?.(job, result);
    } catch (error) {
      const retry =
        transientSourceError(error) &&
        job.attempts < (this.options.maxAttempts ?? 6);
      const conflictError =
        error instanceof HttpError && error.statusCode === 409;
      const code =
        error instanceof HttpError
          ? error.code
          : error instanceof Error
            ? error.name
            : "SOURCE_FAILURE";
      const message =
        error instanceof HttpError
          ? error.message
          : "Source connection failed. The last confirmed data is preserved.";
      const delay = Math.min(
        300000,
        (this.options.retryBaseMs ?? 2000) * 2 ** (job.attempts - 1),
      );
      await this.db.query(
        `UPDATE source_jobs SET status=$3, next_attempt_at=NOW()+($4::double precision * INTERVAL '1 millisecond'),
         lease_token=NULL, lease_until=NULL, error_code=$5, error_message=$6,
         completed_at=CASE WHEN $3='queued' THEN NULL ELSE NOW() END
         WHERE id=$1 AND lease_token=$2`,
        [
          id,
          token,
          retry ? "queued" : conflictError ? "conflicted" : "failed",
          delay,
          code,
          message,
        ],
      );
      await this.options.failed?.(job, error, retry);
    }
    return this.get(id);
  }

  async get(id: string): Promise<SourceJob | undefined> {
    const result = await this.db.query<SourceJob>(
      "SELECT * FROM source_jobs WHERE id=$1",
      [id],
    );
    const job = result.rows[0];
    return job
      ? {
          ...job,
          payload: parseJson(job.payload),
          result: job.result ? parseJson(job.result) : undefined,
        }
      : undefined;
  }

  async drain(): Promise<void> {
    const pending = await this.db.query<{ id: string }>(
      `SELECT id FROM source_jobs WHERE (status='queued' AND next_attempt_at<=NOW()) OR (status='running' AND lease_until<NOW()) ORDER BY sequence LIMIT 10`,
    );
    for (const { id } of pending.rows) await this.run(id);
  }
  async retry(id: string, actorId: string): Promise<SourceJob | undefined> {
    // Preserve attempts: a manual retry must reconcile the previous outcome.
    await inTransaction(this.db, async (tx) => {
      await lockActiveActor(tx, actorId);
      await tx.query(
        "UPDATE source_jobs SET status='queued',next_attempt_at=NOW(),completed_at=NULL WHERE id=$1 AND actor_id=$2 AND status IN ('failed','conflicted')",
        [id, actorId],
      );
    });
    return this.run(id);
  }
  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.active) return;
      this.active = this.drain()
        .catch(() => undefined)
        .finally(() => {
          this.active = undefined;
        });
    };
    this.timer = setInterval(tick, this.options.intervalMs ?? 5000);
    this.timer.unref?.();
    tick();
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}

export function sourceJobResult(job: SourceJob | undefined): unknown {
  if (!job)
    throw new HttpError(
      404,
      "SOURCE_JOB_NOT_FOUND",
      "The source request no longer exists.",
    );
  if (job.status === "succeeded") return job.result;
  if (job.status === "queued" || job.status === "running")
    throw new HttpError(
      503,
      "SOURCE_RETRY_SCHEDULED",
      "Your source request is saved on the server. It will retry automatically; do not create a second request.",
      { operationId: job.operation_id, status: job.status },
    );
  throw new HttpError(
    job.status === "conflicted" ? 409 : 422,
    job.error_code ?? "SOURCE_FAILED",
    job.error_message ??
      "The source request needs review. No confirmed data was discarded.",
    { operationId: job.operation_id, status: job.status },
  );
}
