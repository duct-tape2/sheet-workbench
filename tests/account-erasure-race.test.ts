import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Dataset } from "../packages/core/src/index.ts";
import { prepareAccountErasure } from "../apps/server/src/administration.ts";
import type { SqlClient, SqlResult } from "../apps/server/src/db.ts";
import { migrate } from "../apps/server/src/schema.ts";
import { createServer } from "../apps/server/src/server.ts";
import {
  lockWorkspaceAccess,
  withActorTransaction,
} from "../apps/server/src/write-access.ts";

const actor = {
  id: "erasure-editor",
  name: "Editor",
  email: "editor@example.test",
  emailVerified: true,
};
const owner = "erasure-owner";
const wid = "erasure-workspace";
let db: PGlite;
let app: ReturnType<typeof createServer> | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seed(kind: "xlsx" | "google" = "xlsx") {
  const did = randomUUID();
  const snapshot: Dataset = {
    id: did,
    name: "Unchanged team data",
    source:
      kind === "xlsx"
        ? { kind, fileName: "synthetic.xlsx" }
        : { kind, spreadsheetId: "never-contacted", sheetName: "Tasks" },
    fields: [{ key: "title", label: "Title", type: "text", required: true }],
    mapping: { title: "title" },
    records: [{ id: "record-1", revision: 0, values: { title: "Before" } }],
    revision: 0,
    locale: "en",
    timeZone: "UTC",
    dateOrder: "ymd",
    weekStartsOn: 1,
    completedStatuses: [],
    updatedAt: new Date().toISOString(),
  };
  await db.query(
    "INSERT INTO datasets (id,workspace_id,snapshot,revision,source_kind,created_by) VALUES ($1,$2,$3,0,$4,$5)",
    [did, wid, JSON.stringify(snapshot), kind, owner],
  );
  return snapshot;
}

beforeEach(async () => {
  db = await PGlite.create();
  await migrate(db as unknown as SqlClient);
  for (const id of [actor.id, owner])
    await db.query(
      'INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,$1,$2,TRUE)',
      [id, `${id}@example.test`],
    );
  await db.query(
    "INSERT INTO workspaces (id,name,created_by) VALUES ($1,'Synthetic team',$2)",
    [wid, owner],
  );
  await db.query(
    "INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'editor')",
    [wid, owner, actor.id],
  );
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await db.close();
});

describe("account erasure serialization", () => {
  it.each([
    "new dataset",
    "settings",
    "local patch",
    "Google enqueue",
    "Google undo",
  ] as const)(
    "rejects a stale authorized %s between cleanup and Better Auth's DELETE",
    async (action) => {
      const snapshot = await seed(
        action.startsWith("Google") ? "google" : "xlsx",
      );
      const accessed = deferred();
      const resume = deferred();
      let paused = false;
      const sql: SqlClient = {
        async query<Row>(
          text: string,
          values?: readonly unknown[],
        ): Promise<SqlResult<Row>> {
          const result = await db.query(text, values as unknown[] | undefined);
          // Read the membership first, then hold the HTTP request with its
          // stale authorization while the real cleanup transaction commits.
          if (
            !paused &&
            text ===
              "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2"
          ) {
            paused = true;
            accessed.resolve();
            await resume.promise;
          }
          return result as SqlResult<Row>;
        },
      };
      app = createServer({
        db: sql,
        sessionResolver: async () => actor,
        sourceWorker: false,
      });
      await app.ready();
      const suffix =
        action === "new dataset"
          ? ""
          : `/${snapshot.id}/${action === "settings" ? "settings" : action === "Google undo" ? "undo" : "patch"}`;
      const payload =
        action === "new dataset"
          ? { name: "Must not be created" }
          : action === "settings"
            ? { baseRevision: 0, name: "Must not change" }
            : action === "Google undo"
              ? { operationId: randomUUID(), entryId: "previous-change" }
              : {
                  operationId: randomUUID(),
                  recordId: "record-1",
                  baseRevision: 0,
                  changes: { title: "Must not change" },
                };
      const request = app
        .inject({
          method: "POST",
          url: `/api/workspaces/${wid}/datasets${suffix}`,
          payload,
        })
        .then((response) => response);
      await accessed.promise;
      try {
        await prepareAccountErasure(db as unknown as SqlClient, actor.id);
        expect(
          (
            await db.query(
              "SELECT user_id FROM account_erasure_pending WHERE user_id=$1",
              [actor.id],
            )
          ).rows,
        ).toHaveLength(1);
      } finally {
        resume.resolve();
      }
      const response = await request;
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("ACCOUNT_ERASURE_PENDING");
      expect(
        (
          await db.query<{ snapshot: Dataset }>(
            "SELECT snapshot FROM datasets WHERE id=$1",
            [snapshot.id],
          )
        ).rows[0].snapshot,
      ).toEqual(snapshot);
      for (const table of [
        "source_jobs",
        "source_operations",
        "dataset_changes",
        "dataset_operations",
      ])
        expect(
          (
            await db.query(`SELECT actor_id FROM ${table} WHERE actor_id=$1`, [
              actor.id,
            ])
          ).rows,
        ).toHaveLength(0);
      expect(
        (await db.query("SELECT id FROM datasets WHERE workspace_id=$1", [wid]))
          .rows,
      ).toHaveLength(1);
      // Exact gap in Better Auth: the physical auth delete happens afterward.
      expect(
        (await db.query('DELETE FROM "user" WHERE id=$1', [actor.id]))
          .affectedRows,
      ).toBe(1);
      expect(
        (
          await db.query(
            "SELECT user_id FROM account_erasure_pending WHERE user_id=$1",
            [actor.id],
          )
        ).rows,
      ).toHaveLength(0);
    },
  );

  it("scrubs a completed earlier write, rejects a later write, and permits cleanup retry", async () => {
    const snapshot = await seed();
    await withActorTransaction(
      db as unknown as SqlClient,
      actor.id,
      async (tx) => {
        await lockWorkspaceAccess(tx, wid, actor.id);
        await tx.query(
          "INSERT INTO source_operations (id,dataset_id,operation_id,actor_id,status) VALUES ($1,$2,'before-cleanup',$3,'queued')",
          [randomUUID(), snapshot.id, actor.id],
        );
      },
    );
    await prepareAccountErasure(db as unknown as SqlClient, actor.id);
    await expect(
      withActorTransaction(
        db as unknown as SqlClient,
        actor.id,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_ERASURE_PENDING" });
    await expect(
      prepareAccountErasure(db as unknown as SqlClient, actor.id),
    ).resolves.toBeUndefined();
    expect(
      (
        await db.query(
          "SELECT actor_id FROM source_operations WHERE actor_id=$1",
          [actor.id],
        )
      ).rows,
    ).toHaveLength(0);
    await db.query('DELETE FROM "user" WHERE id=$1', [actor.id]);
    await expect(
      withActorTransaction(
        db as unknown as SqlClient,
        actor.id,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rolls the marker back when a sole owner cannot be erased", async () => {
    await expect(
      prepareAccountErasure(db as unknown as SqlClient, owner),
    ).rejects.toMatchObject({ code: "ACCOUNT_HAS_SOLE_OWNER_WORKSPACE" });
    expect(
      (
        await db.query(
          "SELECT user_id FROM account_erasure_pending WHERE user_id=$1",
          [owner],
        )
      ).rows,
    ).toHaveLength(0);
    await expect(
      withActorTransaction(db as unknown as SqlClient, owner, async (tx) =>
        lockWorkspaceAccess(tx, wid, owner),
      ),
    ).resolves.toBe("owner");
  });
});
