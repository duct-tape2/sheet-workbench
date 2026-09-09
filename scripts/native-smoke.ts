import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Pool } from "pg";
import { createServer } from "../apps/server/src/server.ts";
import { migrate } from "../apps/server/src/schema.ts";
import { importWorkbook } from "../packages/xlsx/src/index.ts";
import type { Dataset } from "../packages/core/src/types.ts";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nativeRoot = resolve(projectRoot, ".local", "native-pg");
// EDB's Windows bootstrap uses an ANSI path internally. The workspace name is
// Korean, so native data initialization needs this temporary ASCII alias. It
// is a junction to `nativeRoot`, never a second copy of the data, and is
// removed as a junction (not recursively) after the smoke run.
const asciiAlias = resolve(
  process.env.SHEET_WORKBENCH_ASCII_TEMP ?? tmpdir(),
  `sheet-workbench-pg-${randomUUID()}`,
);
let activeNativeRoot = nativeRoot;
let activePgRoot = resolve(activeNativeRoot, "pgsql");
let activeBinRoot = resolve(activePgRoot, "bin");
const port = 55_432;
const appBaseURL = "http://127.0.0.1:3001";

function executable(name: string): string {
  return resolve(activeBinRoot, `${name}.exe`);
}

function setActiveNativeRoot(root: string): void {
  activeNativeRoot = resolve(root);
  activePgRoot = resolve(activeNativeRoot, "pgsql");
  activeBinRoot = resolve(activePgRoot, "bin");
}

function normalizedWindowsPath(path: string): string {
  return resolve(path).replaceAll("/", "\\").toLocaleLowerCase("en-US");
}

async function createAsciiJunction(): Promise<void> {
  if (!/^[\x20-\x7e]+$/.test(asciiAlias))
    throw new Error(
      "Set SHEET_WORKBENCH_ASCII_TEMP to an existing ASCII-named temporary directory.",
    );
  try {
    await lstat(asciiAlias);
    throw new Error(`Refusing to reuse existing ASCII alias: ${asciiAlias}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(nativeRoot, asciiAlias, "junction");
  const [aliasTarget, expectedTarget] = await Promise.all([
    realpath(asciiAlias),
    realpath(nativeRoot),
  ]);
  if (
    normalizedWindowsPath(aliasTarget) !== normalizedWindowsPath(expectedTarget)
  )
    throw new Error(
      "Temporary ASCII junction did not resolve to .local/native-pg.",
    );
}

async function removeAsciiJunction(): Promise<void> {
  const [linkTarget, expectedTarget] = await Promise.all([
    readlink(asciiAlias),
    realpath(nativeRoot),
  ]);
  const resolvedTarget = await realpath(asciiAlias);
  if (
    !linkTarget ||
    normalizedWindowsPath(resolvedTarget) !==
      normalizedWindowsPath(expectedTarget)
  )
    throw new Error(
      "Refusing to remove an ASCII alias that is not this native-pg junction.",
    );
  // `rmdir` on a Windows junction removes the junction itself. Do not use a
  // recursive deletion here: the target is the retained portable runtime.
  await rmdir(asciiAlias);
}

async function assertFile(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing from .local/native-pg.`);
  }
}

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  initdbDiagnostics = false,
): Promise<void> {
  await new Promise<void>((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd: activePgRoot,
      env,
      windowsHide: true,
      stdio: initdbDiagnostics ? ["ignore", "pipe", "pipe"] : "ignore",
    });
    let diagnostics = "";
    if (initdbDiagnostics) {
      child.stdout?.on("data", (chunk: Buffer) => {
        diagnostics += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        diagnostics += chunk.toString("utf8");
      });
    }
    child.once("error", () =>
      reject(new Error(`Unable to start native ${basename(command)}.`)),
    );
    child.once("exit", (code) => {
      if (code === 0) return resolveCommand();
      // Only initdb has bounded configuration diagnostics and never receives a
      // password as an argument. Other child output could include connection
      // strings, so it deliberately remains suppressed.
      const detail = initdbDiagnostics
        ? ` ${diagnostics.trim().slice(-2_000)}`
        : "";
      reject(
        new Error(
          `Native ${basename(command)} exited with code ${code}.${detail}`,
        ),
      );
    });
  });
}

async function assertPortUnused(): Promise<void> {
  await new Promise<void>((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once("error", () =>
      reject(
        new Error(
          `127.0.0.1:${port} is already in use; smoke test not started.`,
        ),
      ),
    );
    probe.listen(port, "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : resolvePort())),
    );
  });
}

function isSafeRunDirectory(candidate: string): boolean {
  const normalizedRoot = resolve(activeNativeRoot);
  const normalizedCandidate = resolve(candidate);
  const remainder = relative(normalizedRoot, normalizedCandidate);
  return (
    remainder.length > 0 &&
    !remainder.startsWith(`..${sep}`) &&
    remainder !== ".." &&
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`) &&
    basename(normalizedCandidate).startsWith("run-")
  );
}

async function removeRunDirectory(candidate: string): Promise<void> {
  if (!isSafeRunDirectory(candidate))
    throw new Error("Refusing cleanup outside .local/native-pg/run-*.");
  await rm(candidate, { recursive: true, force: true });
}

function cookieHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value : [value])
    .filter(Boolean)
    .map((cookie) => String(cookie).split(";", 1)[0])
    .join("; ");
}

function requireStatus(statusCode: number, expected: number): void {
  if (statusCode !== expected)
    throw new Error(
      `Application request returned ${statusCode}, expected ${expected}.`,
    );
}

async function smokeApplication(pool: Pool): Promise<void> {
  await migrate(pool);
  const authSecret = randomBytes(48).toString("base64url");
  const email = `native-smoke-${randomUUID()}@example.test`;
  const password = `N-${randomBytes(32).toString("base64url")}`;
  const app = createServer({
    db: pool,
    authConfig: {
      secret: authSecret,
      baseURL: appBaseURL,
      trustedOrigins: [appBaseURL],
    },
  });
  await app.ready();
  try {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin: appBaseURL, host: "127.0.0.1:3001" },
      payload: { name: "Native PostgreSQL Smoke", email, password },
    });
    requireStatus(signup.statusCode, 200);
    const cookies = cookieHeader(signup.headers["set-cookie"]);
    if (!cookies.includes("session_token"))
      throw new Error("Signup did not create a session cookie.");

    const session = await app.inject({
      url: "/api/auth/get-session",
      headers: { cookie: cookies, host: "127.0.0.1:3001" },
    });
    requireStatus(session.statusCode, 200);
    if (session.json().user?.email !== email)
      throw new Error("Session did not resolve the signed-up synthetic user.");

    const workspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: cookies, origin: appBaseURL },
      payload: { name: "Synthetic native PostgreSQL workspace" },
    });
    requireStatus(workspace.statusCode, 200);
    const workspaceId = workspace.json().id as string;
    if (!workspaceId)
      throw new Error("Workspace creation did not return an id.");

    const source = await readFile(resolve(projectRoot, "samples", "team.xlsx"));
    const form = new FormData();
    form.append("storageConsent", "true");
    form.append("file", new Blob([source]), "synthetic-team.xlsx");
    const uploadRequest = new Request("https://native-smoke.invalid", {
      method: "POST",
      body: form,
    });
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/uploads`,
      headers: {
        cookie: cookies,
        origin: appBaseURL,
        "content-type": uploadRequest.headers.get("content-type")!,
      },
      payload: Buffer.from(await uploadRequest.arrayBuffer()),
    });
    requireStatus(uploaded.statusCode, 200);
    const uploadId = uploaded.json().uploadId as string;

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
    const parsed = importWorkbook(source, selection);
    const imported = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/import`,
      headers: { cookie: cookies, origin: appBaseURL },
      payload: {
        ...selection,
        mapping: parsed.mapping,
        name: "Synthetic native PostgreSQL dataset",
        uploadId,
      },
    });
    requireStatus(imported.statusCode, 200);
    const dataset = imported.json() as Dataset;
    const datasetBase = `/api/workspaces/${workspaceId}/datasets/${dataset.id}`;
    const patch = {
      operationId: randomUUID(),
      recordId: dataset.records[0]?.id,
      baseRevision: dataset.records[0]?.revision,
      changes: { [dataset.mapping.title]: "Native PostgreSQL roundtrip title" },
    };
    if (
      !patch.recordId ||
      patch.baseRevision === undefined ||
      !dataset.mapping.title
    )
      throw new Error(
        "Synthetic workbook did not yield a patchable title record.",
      );
    const written = await app.inject({
      method: "POST",
      url: `${datasetBase}/patch`,
      headers: { cookie: cookies, origin: appBaseURL },
      payload: patch,
    });
    requireStatus(written.statusCode, 200);
    const repeated = await app.inject({
      method: "POST",
      url: `${datasetBase}/patch`,
      headers: { cookie: cookies, origin: appBaseURL },
      payload: patch,
    });
    requireStatus(repeated.statusCode, 200);
    if (!isDeepStrictEqual(repeated.json(), written.json()))
      throw new Error("Dataset patch was not idempotent on native PostgreSQL.");
    const loaded = await app.inject({
      url: datasetBase,
      headers: { cookie: cookies },
    });
    requireStatus(loaded.statusCode, 200);
    const stored = loaded.json() as Dataset;
    if (
      stored.records[0]?.values[stored.mapping.title] !==
      "Native PostgreSQL roundtrip title"
    )
      throw new Error(
        "Dataset readback did not preserve the native PostgreSQL write.",
      );

    const exported = await app.inject({
      url: `${datasetBase}/export`,
      headers: { cookie: cookies },
    });
    requireStatus(exported.statusCode, 200);
    const exportedWorkbook = importWorkbook(
      new Uint8Array(exported.rawPayload),
      selection,
    );
    if (
      exportedWorkbook.records[0]?.values[exportedWorkbook.mapping.title] !==
      "Native PostgreSQL roundtrip title"
    )
      throw new Error(
        "Dataset XLSX export did not preserve the native PostgreSQL write.",
      );

    const counts = await pool.query<{
      users: string;
      workspaces: string;
      datasets: string;
      uploads: string;
      changes: string;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM "user")::text AS users,
        (SELECT COUNT(*) FROM workspaces)::text AS workspaces,
        (SELECT COUNT(*) FROM datasets)::text AS datasets,
        (SELECT COUNT(*) FROM uploads)::text AS uploads,
        (SELECT COUNT(*) FROM dataset_changes)::text AS changes`,
    );
    const result = counts.rows[0];
    if (!result || Object.values(result).some((value) => Number(value) < 1))
      throw new Error(
        "Expected synthetic auth, workspace, dataset, upload, and history rows.",
      );
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  await assertPortUnused();
  let junctionCreated = false;
  let started = false;
  let runDirectory: string | undefined;
  let dataDirectory: string | undefined;

  try {
    await createAsciiJunction();
    junctionCreated = true;
    setActiveNativeRoot(asciiAlias);
    for (const name of [
      "initdb",
      "pg_ctl",
      "createdb",
      "pg_dump",
      "pg_restore",
      "postgres",
    ])
      await assertFile(executable(name), name);

    runDirectory = resolve(activeNativeRoot, `run-${randomUUID()}`);
    if (!isSafeRunDirectory(runDirectory))
      throw new Error(
        "Generated native smoke directory was outside the approved root.",
      );
    await mkdir(runDirectory, { recursive: false });
    const activeRunDirectory = runDirectory;
    dataDirectory = resolve(activeRunDirectory, "data");
    const activeDataDirectory = dataDirectory;
    const passwordFile = resolve(activeRunDirectory, "password.txt");
    const serverLog = resolve(activeRunDirectory, "postgres.log");
    const backupFile = resolve(activeRunDirectory, "synthetic.backup");
    const databaseUser = `smoke_${randomUUID().replaceAll("-", "")}`;
    const databasePassword = randomBytes(36).toString("base64url");
    const sourceDatabase = "native_smoke_source";
    const restoredDatabase = "native_smoke_restored";
    const postgresEnvironment = {
      ...process.env,
      PGPASSWORD: databasePassword,
    };
    await writeFile(passwordFile, `${databasePassword}\n`, { mode: 0o600 });
    await run(
      executable("initdb"),
      [
        "-D",
        activeDataDirectory,
        "-U",
        databaseUser,
        "--pwfile",
        passwordFile,
        "--auth",
        "scram-sha-256",
        "--encoding",
        "UTF8",
        "--no-locale",
      ],
      process.env,
      true,
    );
    await appendFile(
      resolve(activeDataDirectory, "postgresql.conf"),
      `\nlisten_addresses = '127.0.0.1'\nport = ${port}\n`,
      "utf8",
    );
    await run(executable("pg_ctl"), [
      "-D",
      activeDataDirectory,
      "-l",
      serverLog,
      "-w",
      "-t",
      "30",
      "start",
    ]);
    started = true;

    const sourceUrl = `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/${sourceDatabase}`;
    const restoredUrl = `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/${restoredDatabase}`;
    await run(
      executable("createdb"),
      [
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        databaseUser,
        sourceDatabase,
      ],
      postgresEnvironment,
    );

    const sourcePool = new Pool({ connectionString: sourceUrl, max: 2 });
    try {
      await smokeApplication(sourcePool);
    } finally {
      await sourcePool.end();
    }

    await run(
      executable("pg_dump"),
      [
        "--format=custom",
        "--file",
        backupFile,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--username",
        databaseUser,
        "--dbname",
        sourceDatabase,
      ],
      postgresEnvironment,
    );
    await run(
      executable("createdb"),
      [
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        databaseUser,
        restoredDatabase,
      ],
      postgresEnvironment,
    );
    await run(
      executable("pg_restore"),
      [
        "--exit-on-error",
        "--clean",
        "--if-exists",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--username",
        databaseUser,
        "--dbname",
        restoredDatabase,
        backupFile,
      ],
      postgresEnvironment,
    );

    const restoredPool = new Pool({ connectionString: restoredUrl, max: 1 });
    try {
      const verified = await restoredPool.query<{
        users: string;
        workspaces: string;
        datasets: string;
        uploads: string;
        changes: string;
        title: string;
      }>(
        `SELECT
          (SELECT COUNT(*) FROM "user")::text AS users,
          (SELECT COUNT(*) FROM workspaces)::text AS workspaces,
          (SELECT COUNT(*) FROM datasets)::text AS datasets,
          (SELECT COUNT(*) FROM uploads)::text AS uploads,
          (SELECT COUNT(*) FROM dataset_changes)::text AS changes,
          (SELECT snapshot->'records'->0->'values'->>(snapshot->'mapping'->>'title') FROM datasets LIMIT 1) AS title`,
      );
      const row = verified.rows[0];
      if (
        !row ||
        Object.values({
          users: row.users,
          workspaces: row.workspaces,
          datasets: row.datasets,
          uploads: row.uploads,
          changes: row.changes,
        }).some((value) => Number(value) < 1) ||
        row.title !== "Native PostgreSQL roundtrip title"
      )
        throw new Error(
          "pg_restore did not preserve the synthetic application data.",
        );
    } finally {
      await restoredPool.end();
    }
    console.log(
      "NATIVE_PG_SMOKE_OK migration auth workspace dataset backup restore",
    );
  } finally {
    try {
      if (started && dataDirectory)
        await run(executable("pg_ctl"), [
          "-D",
          dataDirectory,
          "-m",
          "fast",
          "-w",
          "stop",
        ]).catch(() => undefined);
      if (runDirectory) await removeRunDirectory(runDirectory);
    } finally {
      try {
        if (junctionCreated) await removeAsciiJunction();
      } finally {
        setActiveNativeRoot(nativeRoot);
      }
    }
  }
}

await main();
