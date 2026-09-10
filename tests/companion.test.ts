import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import {
  companionWorkbookFixtures,
  createCompanionService,
  createSyntheticWorkbook,
  indexWorkbook,
  patchWorkbook,
} from "../packages/companion/src/index.ts";

const port = 45_191;
const origin = `http://127.0.0.1:${port}`;

function multipartPayload(
  bytes: Uint8Array,
  filename: string,
): { body: Buffer; contentType: string } {
  const boundary = "----sheet-workbench-companion-test";
  return {
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function setCookies(response: { headers: { [key: string]: unknown } }): string {
  const raw = response.headers["set-cookie"];
  const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(
    (value): value is string => typeof value === "string",
  );
  return values.map((value) => value.split(";")[0]).join("; ");
}

function csrf(cookies: string): string {
  const found = /(?:^|; )companion_csrf=([^;]+)/.exec(cookies);
  if (!found) throw new Error("Bootstrap did not set a CSRF cookie.");
  return found[1];
}

function withFormulaError(source: Uint8Array): Uint8Array {
  const files = unzipSync(source);
  const sheetPath = "xl/worksheets/sheet1.xml";
  const original = strFromU8(files[sheetPath]!);
  const changed = original.replace(
    /<c r="B4">(<f>[\s\S]*?<\/f>)<v>[\s\S]*?<\/v><\/c>/,
    '<c r="B4" t="e">$1<v>#DIV/0!</v></c>',
  );
  if (changed === original)
    throw new Error("Synthetic formula cell was not found.");
  files[sheetPath] = strToU8(changed);
  return zipSync(files, { level: 6 });
}

async function ready(
  recalculate: (filePath: string) => Promise<void> = async () => undefined,
) {
  const state = await mkdtemp(
    path.join(os.tmpdir(), "sheet-workbench-companion-test-"),
  );
  const companion = await createCompanionService({
    dataDir: state,
    serveWeb: false,
    port,
    // Unit coverage must not open a native Excel process. Native coverage is
    // performed separately by scripts/companion-excel-smoke.ts.
    excelRunner: { recalculate },
  });
  const bootstrap = new URL(companion.bootstrapUrl()).searchParams.get(
    "bootstrap",
  )!;
  const login = await companion.app.inject({
    method: "GET",
    url: `/?bootstrap=${encodeURIComponent(bootstrap)}`,
    headers: { host: `127.0.0.1:${port}` },
  });
  expect(login.statusCode).toBe(302);
  const cookies = setCookies(login);
  const headers = {
    host: `127.0.0.1:${port}`,
    origin,
    cookie: cookies,
    "x-companion-csrf": csrf(cookies),
  };
  return { companion, state, headers };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("companion synthetic workbook coverage", () => {
  it("profiles twelve independent payroll, expense, order, and sales variants", () => {
    const fixtures = companionWorkbookFixtures();
    expect(fixtures).toHaveLength(12);
    expect(new Set(fixtures.map((fixture) => fixture.domain))).toEqual(
      new Set(["payroll", "expense", "orders", "sales"]),
    );
    for (const fixture of fixtures) {
      const profile = indexWorkbook(fixture.bytes);
      const total = profile.sheets
        .get(fixture.sheetName)
        ?.cells.get(fixture.totalAddress);
      expect(total?.value, fixture.id).toBe(fixture.expectedTotal);
      expect(total?.formula, fixture.id).toMatch(/^=SUM\(B2:B\d+\)/);
      expect(
        profile.sheets.get(fixture.sheetName)?.cells.get("A2")?.value,
        fixture.id,
      ).toBe(fixture.expectedLabels[0]);
      if (fixture.shape === "hidden-crossref") {
        expect(profile.sheets.get("__Controls")?.hidden, fixture.id).toBe(true);
        expect(total?.formula, fixture.id).toContain("__Controls!B1");
      }
      if (fixture.shape === "nested-names") {
        expect(total?.formula, fixture.id).toContain("Carry");
        expect(profile.profile.definedNames).toEqual(["BaseAmount", "Carry"]);
      }
    }
  });

  it("preserves direct inline and shared-string identifiers exactly", () => {
    const inline = indexWorkbook(
      createSyntheticWorkbook({
        sheetName: "Labels",
        rows: [
          { label: "001", amount: 1 },
          { label: "false", amount: 2 },
        ],
      }),
    );
    expect(inline.sheets.get("Labels")?.cells.get("A2")?.value).toBe("001");
    expect(inline.sheets.get("Labels")?.cells.get("A3")?.value).toBe("false");

    const files = unzipSync(
      createSyntheticWorkbook({
        sheetName: "Shared labels",
        rows: [
          { label: "replace", amount: 1 },
          { label: "replace", amount: 2 },
        ],
      }),
    );
    files["xl/sharedStrings.xml"] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t xml:space="preserve"> 001 </t></si><si><r><t>EMP</t></r><r><t>-007</t></r></si></sst>',
    );
    files["xl/worksheets/sheet1.xml"] = strToU8(
      strFromU8(files["xl/worksheets/sheet1.xml"]!)
        .replace(/<c r="A2"[^>]*>[\s\S]*?<\/c>/, '<c r="A2" t="s"><v>0</v></c>')
        .replace(
          /<c r="A3"[^>]*>[\s\S]*?<\/c>/,
          '<c r="A3" t="s"><v>1</v></c>',
        ),
    );
    const shared = indexWorkbook(zipSync(files, { level: 6 }));
    expect(shared.sheets.get("Shared labels")?.cells.get("A2")?.value).toBe(
      " 001 ",
    );
    expect(shared.sheets.get("Shared labels")?.cells.get("A3")?.value).toBe(
      "EMP-007",
    );
  });

  it("fails closed for shared formula anchors and followers", () => {
    const source = createSyntheticWorkbook({
      sheetName: "Shared Formula",
      rows: [
        { label: "001", amount: 1 },
        { label: "002", amount: 2 },
      ],
      shape: "shared-formula",
    });
    const indexed = indexWorkbook(source);
    expect(indexed.profile.readOnlyReasons.join(" ")).toMatch(/shared/i);
    expect(
      indexed.sheets.get("Shared Formula")?.cells.get("B4")?.formulaKind,
    ).toBe("shared");
    expect(indexed.sheets.get("Shared Formula")?.cells.get("B5")?.formula).toBe(
      "=<protected formula>",
    );
    expect(() =>
      patchWorkbook(source, [
        { sheet: "Shared Formula", address: "B2", before: 1, after: 2 },
      ]),
    ).toThrow(/shared/i);
  });

  it("marks VBA, external-link, Power Query, and hidden-sheet variants read-only", () => {
    const vba = indexWorkbook(
      createSyntheticWorkbook({
        sheetName: "Macro",
        rows: [{ label: "A", amount: 1 }],
        flags: { hasVba: true },
      }),
    );
    const linked = indexWorkbook(
      createSyntheticWorkbook({
        sheetName: "Linked",
        rows: [{ label: "A", amount: 1 }],
        flags: { hasExternalLinks: true },
      }),
    );
    const query = indexWorkbook(
      createSyntheticWorkbook({
        sheetName: "Query",
        rows: [{ label: "A", amount: 1 }],
        flags: { hasPowerQuery: true },
      }),
    );
    const hidden = indexWorkbook(
      createSyntheticWorkbook({
        sheetName: "Hidden",
        hidden: true,
        rows: [{ label: "A", amount: 1 }],
      }),
    );
    expect(vba.profile.readOnlyReasons.join(" ")).toMatch(/VBA/);
    expect(linked.profile.readOnlyReasons.join(" ")).toMatch(/external/i);
    expect(query.profile.readOnlyReasons.join(" ")).toMatch(/Power Query/i);
    expect(hidden.profile.sheets[0]?.hidden).toBe(true);
  });

  it("profiles cached formula errors as read-only across the workbook", () => {
    const errored = indexWorkbook(
      withFormulaError(
        createSyntheticWorkbook({
          sheetName: "Errors",
          rows: [
            { label: "A", amount: 1 },
            { label: "B", amount: 2 },
          ],
        }),
      ),
    );
    expect(errored.profile.flags.hasFormulaErrors).toBe(true);
    expect(errored.profile.readOnlyReasons.join(" ")).toMatch(
      /formula errors/i,
    );
  });

  it("blocks indirect external calculation in cells and defined names", () => {
    const fixture = createSyntheticWorkbook({
      sheetName: "Safe",
      rows: [
        { label: "A", amount: 1 },
        { label: "B", amount: 2 },
      ],
    });
    for (const expression of [
      "WEBSERVICE(A2)",
      "RTD(A2,A3)",
      "_xlfn.PY(A2)",
      "CALL(A2)",
    ]) {
      const files = unzipSync(fixture);
      files["xl/worksheets/sheet1.xml"] = strToU8(
        strFromU8(files["xl/worksheets/sheet1.xml"]!).replace(
          "SUM(B2:B3)",
          expression,
        ),
      );
      expect(
        indexWorkbook(zipSync(files)).profile.readOnlyReasons.join(" "),
      ).toMatch(/code-executing/);
    }
    const named = unzipSync(fixture);
    named["xl/workbook.xml"] = strToU8(
      strFromU8(named["xl/workbook.xml"]!).replace(
        "</workbook>",
        '<definedNames><definedName name="Remote">WEBSERVICE(Safe!A2)</definedName></definedNames></workbook>',
      ),
    );
    expect(
      indexWorkbook(zipSync(named)).profile.readOnlyReasons.join(" "),
    ).toMatch(/code-executing/);
  });
});

describe("companion loopback boundary", () => {
  it("requires host, bootstrap session, exact origin, and matching CSRF", async () => {
    const { companion, state, headers } = await ready();
    cleanups.push(async () => {
      await companion.close();
      await rm(state, { recursive: true, force: true });
    });
    const wrongHost = await companion.app.inject({
      method: "GET",
      url: "/",
      headers: { host: "localhost:45191" },
    });
    expect(wrongHost.statusCode).toBe(421);
    const missingAuth = await companion.app.inject({
      method: "GET",
      url: "/companion/health",
      headers: { host: `127.0.0.1:${port}`, origin },
    });
    expect(missingAuth.statusCode).toBe(401);
    const { origin: _origin, ...headersWithoutOrigin } = headers;
    const browserRead = await companion.app.inject({
      method: "GET",
      url: "/companion/health",
      headers: {
        ...headersWithoutOrigin,
        "sec-fetch-site": "same-origin",
        referer: `${origin}/?mode=work`,
      },
    });
    expect(browserRead.statusCode).toBe(200);
    const spoofedRead = await companion.app.inject({
      method: "GET",
      url: "/companion/health",
      headers: { ...headersWithoutOrigin, "sec-fetch-site": "same-origin" },
    });
    expect(spoofedRead.statusCode).toBe(403);
  });

  it("stores selected bytes behind an opaque ID and verifies an evidence-backed literal patch", async () => {
    const { companion, state, headers } = await ready();
    cleanups.push(async () => {
      await companion.close();
      await rm(state, { recursive: true, force: true });
    });
    const source = createSyntheticWorkbook({
      sheetName: "Payroll",
      rows: [
        { label: "Ari", amount: 1000 },
        { label: "Bo", amount: 1200 },
      ],
    });
    const upload = multipartPayload(source, "payroll.xlsx");
    const uploaded = await companion.app.inject({
      method: "POST",
      url: "/companion/files",
      headers: { ...headers, "content-type": upload.contentType },
      payload: upload.body,
    });
    expect(uploaded.statusCode).toBe(200);
    const file = (
      uploaded.json() as { file: { id: string; sha256: string; name: string } }
    ).file;
    expect(file.name).toBe("payroll.xlsx");
    expect(file.id).toMatch(/^[0-9a-f-]{36}$/);

    const extracted = await companion.app.inject({
      method: "POST",
      url: `/companion/files/${file.id}/extract`,
      headers,
    });
    expect(extracted.statusCode).toBe(200);

    const requestId = randomUUID();
    const patch = {
      sourceId: file.id,
      sourceHash: file.sha256,
      requestId,
      period: "2026-09",
      changes: [
        {
          sheet: "Payroll",
          address: "B2",
          before: 1000,
          after: 1100,
          evidence: [{ fileId: file.id, quote: "Payroll" }],
        },
      ],
      checks: [{ sheet: "Payroll", address: "B2", expected: 1100 }],
      approved: true,
    } as const;
    const run = await companion.app.inject({
      method: "POST",
      url: "/companion/runs",
      headers: { ...headers, "content-type": "application/json" },
      payload: { fileId: file.id, patch },
    });
    expect(run.statusCode).toBe(200);
    const result = run.json() as {
      status: string;
      verification: string;
      download: string;
    };
    expect(result.status).toBe("verified");
    expect(result.verification).toBe("native-excel");

    const repeated = await companion.app.inject({
      method: "POST",
      url: "/companion/runs",
      headers: { ...headers, "content-type": "application/json" },
      payload: { fileId: file.id, patch },
    });
    expect(repeated.json()).toEqual(result);
    const concurrentIds = [randomUUID(), randomUUID()];
    const concurrent = await Promise.all(
      concurrentIds.map((id) =>
        companion.app.inject({
          method: "POST",
          url: "/companion/runs",
          headers: { ...headers, "content-type": "application/json" },
          payload: { fileId: file.id, patch: { ...patch, requestId: id } },
        }),
      ),
    );
    expect(concurrent.map((response) => response.statusCode)).toEqual([
      200, 200,
    ]);
    const durable = JSON.parse(
      await readFile(path.join(state, "request-ledger.json"), "utf8"),
    );
    expect(Object.keys(durable).sort()).toEqual(
      [requestId, ...concurrentIds].sort(),
    );
    const mismatched = await companion.app.inject({
      method: "POST",
      url: "/companion/runs",
      headers: { ...headers, "content-type": "application/json" },
      payload: { fileId: file.id, patch: { ...patch, period: "2026-10" } },
    });
    expect(mismatched.statusCode).toBe(409);

    const downloaded = await companion.app.inject({
      method: "GET",
      url: result.download,
      headers,
    });
    expect(downloaded.statusCode).toBe(200);
    const reopened = indexWorkbook(new Uint8Array(downloaded.rawPayload));
    expect(reopened.sheets.get("Payroll")?.cells.get("B2")?.value).toBe(1100);
    expect(reopened.sheets.get("Payroll")?.cells.get("B4")?.formula).toBe(
      "=SUM(B2:B3)",
    );
  });

  it("rejects a native runner that loses an approved target value", async () => {
    const { companion, state, headers } = await ready(async (filePath) => {
      const current = new Uint8Array(await readFile(filePath));
      const corrupted = patchWorkbook(current, [
        { sheet: "Payroll", address: "B2", before: 1100, after: 1200 },
      ]);
      await writeFile(filePath, corrupted);
    });
    cleanups.push(async () => {
      await companion.close();
      await rm(state, { recursive: true, force: true });
    });
    const source = createSyntheticWorkbook({
      sheetName: "Payroll",
      rows: [
        { label: "Ari", amount: 1000 },
        { label: "Bo", amount: 1200 },
      ],
    });
    const upload = multipartPayload(source, "payroll.xlsx");
    const uploaded = await companion.app.inject({
      method: "POST",
      url: "/companion/files",
      headers: { ...headers, "content-type": upload.contentType },
      payload: upload.body,
    });
    const file = (uploaded.json() as { file: { id: string; sha256: string } })
      .file;
    await companion.app.inject({
      method: "POST",
      url: `/companion/files/${file.id}/extract`,
      headers,
    });
    const response = await companion.app.inject({
      method: "POST",
      url: "/companion/runs",
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        fileId: file.id,
        patch: {
          sourceId: file.id,
          sourceHash: file.sha256,
          requestId: randomUUID(),
          period: "2026-09",
          changes: [
            {
              sheet: "Payroll",
              address: "B2",
              before: 1000,
              after: 1100,
              evidence: [{ fileId: file.id, quote: "Payroll" }],
            },
          ],
          checks: [],
          approved: true,
        },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "TARGET_WRITE_NOT_PRESERVED",
    });
  });

  it("reports cached source formula errors before attempting a native run", async () => {
    const { companion, state, headers } = await ready();
    cleanups.push(async () => {
      await companion.close();
      await rm(state, { recursive: true, force: true });
    });
    const upload = multipartPayload(
      withFormulaError(
        createSyntheticWorkbook({
          sheetName: "Payroll",
          rows: [
            { label: "Ari", amount: 1000 },
            { label: "Bo", amount: 1200 },
          ],
        }),
      ),
      "payroll.xlsx",
    );
    const uploaded = await companion.app.inject({
      method: "POST",
      url: "/companion/files",
      headers: { ...headers, "content-type": upload.contentType },
      payload: upload.body,
    });
    const file = (uploaded.json() as { file: { id: string; sha256: string } })
      .file;
    await companion.app.inject({
      method: "POST",
      url: `/companion/files/${file.id}/extract`,
      headers,
    });
    const response = await companion.app.inject({
      method: "POST",
      url: "/companion/runs",
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        fileId: file.id,
        patch: {
          sourceId: file.id,
          sourceHash: file.sha256,
          requestId: randomUUID(),
          period: "2026-09",
          changes: [
            {
              sheet: "Payroll",
              address: "B2",
              before: 1000,
              after: 1100,
              evidence: [{ fileId: file.id, quote: "Payroll" }],
            },
          ],
          checks: [],
          approved: true,
        },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "SOURCE_FORMULA_ERROR" });
  });

  it("rejects formula errors introduced by native recalculation anywhere in the output", async () => {
    const { companion, state, headers } = await ready(async (filePath) => {
      await writeFile(
        filePath,
        withFormulaError(new Uint8Array(await readFile(filePath))),
      );
    });
    cleanups.push(async () => {
      await companion.close();
      await rm(state, { recursive: true, force: true });
    });
    const source = createSyntheticWorkbook({
      sheetName: "Payroll",
      rows: [
        { label: "Ari", amount: 1000 },
        { label: "Bo", amount: 1200 },
      ],
    });
    const upload = multipartPayload(source, "payroll.xlsx");
    const uploaded = await companion.app.inject({
      method: "POST",
      url: "/companion/files",
      headers: { ...headers, "content-type": upload.contentType },
      payload: upload.body,
    });
    const file = (uploaded.json() as { file: { id: string; sha256: string } })
      .file;
    await companion.app.inject({
      method: "POST",
      url: `/companion/files/${file.id}/extract`,
      headers,
    });
    const response = await companion.app.inject({
      method: "POST",
      url: "/companion/runs",
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        fileId: file.id,
        patch: {
          sourceId: file.id,
          sourceHash: file.sha256,
          requestId: randomUUID(),
          period: "2026-09",
          changes: [
            {
              sheet: "Payroll",
              address: "B2",
              before: 1000,
              after: 1100,
              evidence: [{ fileId: file.id, quote: "Payroll" }],
            },
          ],
          checks: [],
          approved: true,
        },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "POST_RECALC_FORMULA_ERROR",
    });
  });
});
