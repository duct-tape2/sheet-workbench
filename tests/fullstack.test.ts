import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { it, expect } from "vitest";
import { createServer } from "../apps/server/src/server";
import { migrate } from "../apps/server/src/schema";
import type { SqlClient } from "../apps/server/src/db";
import { importWorkbook } from "../packages/xlsx/src/index";
import { report, weekRange, type Dataset } from "../packages/core/src/index";

it("real sample upload→mapping→SQL→edit→download→reimport uses compatible IDs and retains original", async () => {
  const db = new PGlite();
  await migrate(db as unknown as SqlClient);
  await db.query(
    'INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,$2,$3,TRUE)',
    ["acceptance-user", "Acceptance", "acceptance@example.test"],
  );
  const app = createServer({
    db: db as unknown as SqlClient,
    sessionResolver: () => ({
      id: "acceptance-user",
      email: "acceptance@example.test",
      emailVerified: true,
    }),
  });
  await app.ready();
  try {
    const space = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Synthetic acceptance workspace" },
    });
    expect(space.statusCode, space.body).toBe(200);
    const wid = space.json().id;
    const bytes = readFileSync(
      new URL("../samples/team.xlsx", import.meta.url),
    );
    const upload = async (content: Uint8Array) => {
      const form = new FormData();
      form.append("storageConsent", "true");
      form.append("file", new Blob([content as BlobPart]), "team.xlsx");
      const request = new Request("https://test.invalid", {
        method: "POST",
        body: form,
      });
      const result = await app.inject({
        method: "POST",
        url: `/api/workspaces/${wid}/uploads`,
        headers: { "content-type": request.headers.get("content-type")! },
        payload: Buffer.from(await request.arrayBuffer()),
      });
      expect(result.statusCode, result.body).toBe(200);
      return result.json().uploadId as string;
    };
    const uploadId = await upload(bytes);
    const selection = {
      sheetName: "Tasks",
      headerRow: 1,
      startColumn: 1,
      endColumn: 8,
      endRow: 13,
      dateOrder: "ymd" as const,
      locale: "en" as const,
      timeZone: "UTC",
      weekStartsOn: 1 as const,
    };
    const local = importWorkbook(bytes, selection);
    const imported = await app.inject({
      method: "POST",
      url: `/api/workspaces/${wid}/import`,
      payload: {
        ...selection,
        mapping: local.mapping,
        name: "Acceptance tasks",
        uploadId,
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const d = imported.json() as Dataset,
      base = `/api/workspaces/${wid}/datasets/${d.id}`;
    const patch = {
      operationId: randomUUID(),
      recordId: d.records[0].id,
      baseRevision: d.records[0].revision,
      changes: { [d.mapping.title]: "Confirmed imported task" },
    };
    const written = await app.inject({
      method: "POST",
      url: `${base}/patch`,
      payload: patch,
    });
    expect(written.statusCode, written.body).toBe(200);
    const repeated = await app.inject({
      method: "POST",
      url: `${base}/patch`,
      payload: patch,
    });
    expect(repeated.json()).toEqual(written.json());
    const got = await app.inject(base);
    const stored = got.json() as Dataset;
    expect(stored.records[0].values[stored.mapping.title]).toBe(
      "Confirmed imported task",
    );
    expect(report(stored, weekRange("2026-09-08")).total).toBe(7);
    const settings = await app.inject({
      method: "POST",
      url: `${base}/settings`,
      payload: {
        baseRevision: stored.revision,
        fields: stored.fields.map(({ type: _type, ...field }) => field),
        categoryColors: { operations: 2 },
      },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    const exported = await app.inject(`${base}/export`);
    expect(exported.statusCode, exported.body).toBe(200);
    const downloaded = importWorkbook(
      new Uint8Array(exported.rawPayload),
      selection,
    );
    expect(downloaded.records[0].values[downloaded.mapping.title]).toBe(
      "Confirmed imported task",
    );
    expect(
      (
        await db.query<{ content: Uint8Array }>(
          "SELECT content FROM uploads WHERE id=$1",
          [uploadId],
        )
      ).rows[0].content,
    ).toEqual(new Uint8Array(bytes));
    const replacement = await upload(exported.rawPayload);
    const preview = await app.inject({
      method: "POST",
      url: `${base}/reimport/preview`,
      payload: { uploadId: replacement },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().conflicts).toEqual([]);
    const confirmed = await app.inject({
      method: "POST",
      url: `${base}/reimport/confirm`,
      payload: {
        previewId: preview.json().previewId,
        baseRevision: preview.json().baseRevision,
        operationId: randomUUID(),
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
  } finally {
    await app.close();
    await db.close();
  }
}, 30000);
