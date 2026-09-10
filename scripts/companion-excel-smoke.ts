import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  cellAt,
  companionWorkbookFixtures,
  createCompanionService,
  dedicatedExcelRecalculator,
  indexWorkbook,
  probeExcelRuntime,
} from "../packages/companion/src/index.ts";

const port = 46_519;
const origin = `http://127.0.0.1:${port}`;
const selectedFixtureId = process.env.COMPANION_SMOKE_FIXTURE;

function multipartPayload(
  bytes: Uint8Array,
  filename: string,
): { body: Buffer; contentType: string } {
  const boundary = "----sheet-workbench-companion-native-smoke";
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

function cookies(setCookie: unknown): string {
  const values = (
    Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  ).filter((value): value is string => typeof value === "string");
  return values.map((value) => value.split(";")[0]).join("; ");
}

function csrf(cookie: string): string {
  const found = /(?:^|; )companion_csrf=([^;]+)/.exec(cookie);
  if (!found)
    throw new Error("The native smoke bootstrap did not set a CSRF cookie.");
  return found[1];
}

function diagnosticCode(response: { json(): unknown }): string {
  try {
    const body = response.json() as { code?: unknown };
    return typeof body.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(body.code)
      ? body.code
      : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

const smokeDir = await mkdtemp(
  path.join(os.tmpdir(), "sheet-workbench-companion-smoke-"),
);
let companion: Awaited<ReturnType<typeof createCompanionService>> | undefined;
let fixtureId = "bootstrap";
let phase = "bootstrap";
try {
  const runtime = await probeExcelRuntime();
  if (!runtime.available) {
    console.error(
      "COMPANION_EXCEL_SMOKE_UNAVAILABLE xlwings_or_excel_not_available",
    );
    process.exitCode = 2;
  } else {
    const calculator = dedicatedExcelRecalculator(runtime.pythonPath);
    companion = await createCompanionService({
      dataDir: path.join(smokeDir, "service-state"),
      serveWeb: false,
      port,
      pythonPath: runtime.pythonPath,
      excelRunner: calculator,
    });
    const bootstrap = new URL(companion.bootstrapUrl()).searchParams.get(
      "bootstrap",
    );
    if (!bootstrap)
      throw new Error(
        "The native smoke companion did not issue a bootstrap token.",
      );
    const login = await companion.app.inject({
      method: "GET",
      url: `/?bootstrap=${encodeURIComponent(bootstrap)}`,
      headers: { host: `127.0.0.1:${port}` },
    });
    if (login.statusCode !== 302)
      throw new Error("The native smoke companion bootstrap failed.");
    const cookie = cookies(login.headers["set-cookie"]);
    const headers = {
      host: `127.0.0.1:${port}`,
      origin,
      cookie,
      "x-companion-csrf": csrf(cookie),
    };

    const fixtures = companionWorkbookFixtures();
    const selectedFixtures = selectedFixtureId
      ? fixtures.filter((fixture) => fixture.id === selectedFixtureId)
      : fixtures;
    if (!selectedFixtures.length)
      throw new Error(
        "COMPANION_EXCEL_SMOKE_FAILED fixture=selection phase=select: UNKNOWN_FIXTURE",
      );
    for (const fixture of selectedFixtures) {
      fixtureId = fixture.id;
      // Excel supplies normal package defaults on first save. Each fixture is
      // first normalized in the owned native process; the actual service run
      // then proves its patch/reopen/structural verification path against that
      // native baseline.
      const baselinePath = path.join(smokeDir, `${fixture.id}-baseline.xlsx`);
      phase = "native_baseline";
      await writeFile(baselinePath, fixture.bytes, { flag: "wx" });
      await calculator.recalculate(baselinePath);
      phase = "upload";
      const baseline = new Uint8Array(await readFile(baselinePath));
      const multipart = multipartPayload(baseline, `${fixture.id}.xlsx`);
      const uploaded = await companion.app.inject({
        method: "POST",
        url: "/companion/files",
        headers: { ...headers, "content-type": multipart.contentType },
        payload: multipart.body,
      });
      if (uploaded.statusCode !== 200)
        throw new Error(`Native upload failed for ${fixture.id}.`);
      const file = uploaded.json() as { file: { id: string; sha256: string } };
      const extracted = await companion.app.inject({
        method: "POST",
        url: `/companion/files/${file.file.id}/extract`,
        headers,
      });
      if (extracted.statusCode !== 200)
        throw new Error(`Native extraction failed for ${fixture.id}.`);
      phase = "run";
      const indexed = indexWorkbook(baseline);
      const before = cellAt(indexed, fixture.sheetName, "B2");
      if (!before || typeof before.value !== "number")
        throw new Error(`Native fixture input missing for ${fixture.id}.`);
      const run = await companion.app.inject({
        method: "POST",
        url: "/companion/runs",
        headers: { ...headers, "content-type": "application/json" },
        payload: {
          fileId: file.file.id,
          patch: {
            sourceId: file.file.id,
            sourceHash: file.file.sha256,
            requestId: randomUUID(),
            period: "2026-09",
            changes: [
              {
                sheet: fixture.sheetName,
                address: "B2",
                before: before.value,
                after: before.value + 1,
                evidence: [{ fileId: file.file.id, quote: fixture.sheetName }],
              },
            ],
            checks: [
              {
                sheet: fixture.sheetName,
                address: fixture.totalAddress,
                expected: fixture.expectedTotal + 1,
              },
            ],
            approved: true,
          },
        },
      });
      if (run.statusCode !== 200)
        throw new Error(
          `Native service run failed for ${fixture.id}: status=${run.statusCode} code=${diagnosticCode(run)}.`,
        );
      const result = run.json() as {
        status: string;
        verification: string;
        download?: string;
      };
      if (
        result.status !== "verified" ||
        result.verification !== "native-excel" ||
        !result.download
      )
        throw new Error(
          `Native service verification did not complete for ${fixture.id}.`,
        );
      const downloaded = await companion.app.inject({
        method: "GET",
        url: result.download,
        headers,
      });
      if (downloaded.statusCode !== 200)
        throw new Error(`Native download failed for ${fixture.id}.`);
      phase = "verify_download";
      const reopened = indexWorkbook(new Uint8Array(downloaded.rawPayload));
      if (cellAt(reopened, fixture.sheetName, "B2")?.value !== before.value + 1)
        throw new Error(
          `Native literal target was not preserved for ${fixture.id}.`,
        );
      if (
        cellAt(reopened, fixture.sheetName, fixture.totalAddress)?.value !==
        fixture.expectedTotal + 1
      )
        throw new Error(`Native total did not recalculate for ${fixture.id}.`);
    }
    phase = "complete";
    console.log(
      `COMPANION_EXCEL_SMOKE_OK native_service_runs=${selectedFixtures.length} dedicated_instance=true structural_integrity=true`,
    );
  }
} catch (error) {
  const detail =
    error instanceof Error
      ? error.message.replace(/[\r\n]+/g, " ").slice(0, 240)
      : "UnknownError";
  throw new Error(
    `COMPANION_EXCEL_SMOKE_FAILED fixture=${fixtureId} phase=${phase}: ${detail}`,
  );
} finally {
  await companion?.close();
  await rm(smokeDir, { recursive: true, force: true });
}
