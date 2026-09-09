import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../apps/server/src/schema.ts";
import type { SqlClient } from "../apps/server/src/db.ts";
import {
  SourceQueue,
  sourceJobResult,
  transientSourceError,
} from "../apps/server/src/source-queue.ts";
import { HttpError, conflict } from "../apps/server/src/errors.ts";

let db: PGlite;
const input = {
  workspace_id: "w",
  dataset_id: "d",
  actor_id: "u",
  operation_id: "operation-0001",
  kind: "patch" as const,
  payload: { changes: { title: "Next" } },
};
beforeEach(async () => {
  db = new PGlite();
  await migrate(db as unknown as SqlClient);
  await db.query(
    `INSERT INTO "user" (id,name,email) VALUES ('u','Test','test@example.test')`,
  );
  await db.query(
    `INSERT INTO workspaces (id,name,created_by) VALUES ('w','Test','u')`,
  );
  await db.query(
    `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('w','u','owner')`,
  );
  await db.query(
    `INSERT INTO datasets (id,workspace_id,snapshot,revision,source_kind,created_by) VALUES ('d','w','{"revision":0}',0,'google','u')`,
  );
});
afterEach(async () => {
  await db.close();
});
it("persists requests, executes once, rejects operation ID reuse and captures version snapshots", async () => {
  const execute = vi.fn(async () => ({ datasetRevision: 1 }));
  const queue = new SourceQueue(db as unknown as SqlClient, { execute });
  const job = await queue.enqueue(input);
  expect((await queue.enqueue(input)).id).toBe(job.id);
  expect(sourceJobResult(await queue.run(job.id))).toEqual({
    datasetRevision: 1,
  });
  await queue.run(job.id);
  expect(execute).toHaveBeenCalledTimes(1);
  await expect(
    queue.enqueue({ ...input, payload: { changes: { title: "Other" } } }),
  ).rejects.toThrow(/different request/);
  expect((await db.query("SELECT * FROM dataset_versions")).rows).toHaveLength(
    1,
  );
  await db.query(
    `UPDATE datasets SET snapshot='{"revision":1}',revision=1 WHERE id='d'`,
  );
  await db.query(
    `UPDATE datasets SET snapshot='{"revision":1,"lastCheckedAt":"now"}' WHERE id='d'`,
  );
  expect((await db.query("SELECT * FROM dataset_versions")).rows).toHaveLength(
    2,
  );
});
it("retains FIFO through transient failure and recovers after a process restart", async () => {
  const execute = vi
    .fn()
    .mockRejectedValueOnce(
      new HttpError(503, "GOOGLE_UNAVAILABLE", "Temporary"),
    );
  const queue = new SourceQueue(db as unknown as SqlClient, {
    execute,
    retryBaseMs: 0,
  });
  const first = await queue.enqueue(input);
  const second = await queue.enqueue({
    ...input,
    operation_id: "operation-0002",
  });
  expect((await queue.run(first.id))?.status).toBe("queued");
  expect((await queue.run(second.id))?.status).toBe("queued");
  expect(execute).toHaveBeenCalledTimes(1);
  const replay = vi.fn(async (job) => ({ attempt: job.attempts }));
  const restarted = new SourceQueue(db as unknown as SqlClient, {
    execute: replay,
  });
  await restarted.drain();
  expect(replay.mock.calls.map(([job]) => job.operation_id)).toEqual([
    input.operation_id,
    "operation-0002",
  ]);
  expect((await restarted.get(first.id))?.result).toEqual({ attempt: 2 });
});
it("revoked access and conflicts stop retries without discarding confirmed data", async () => {
  const execute = vi.fn(async () => {
    throw conflict("Source changed");
  });
  const queue = new SourceQueue(db as unknown as SqlClient, { execute });
  const first = await queue.enqueue(input);
  expect((await queue.run(first.id))?.status).toBe("conflicted");
  const second = await queue.enqueue({
    ...input,
    operation_id: "operation-0002",
  });
  await db.query("UPDATE workspace_members SET role='viewer'");
  const denied = await queue.run(second.id);
  expect(denied?.status).toBe("failed");
  expect(denied?.error_code).toBe("FORBIDDEN");
  expect(execute).toHaveBeenCalledTimes(1);
});
it("reclaims expired leases and never retries uncertain postwrite conflicts blindly", async () => {
  const execute = vi.fn(async () => ({ recovered: true }));
  const queue = new SourceQueue(db as unknown as SqlClient, { execute });
  const job = await queue.enqueue(input);
  await db.query(
    "UPDATE source_jobs SET status='running', attempts=1, lease_token='dead', lease_until=NOW()-INTERVAL '1 second'",
  );
  await queue.drain();
  expect(execute.mock.calls[0]?.length).toBe(2);
  expect((await queue.get(job.id))?.attempts).toBe(2);
  expect(
    transientSourceError(
      new HttpError(503, "GOOGLE_POSTWRITE_UNCERTAIN", "Review"),
    ),
  ).toBe(false);
});
