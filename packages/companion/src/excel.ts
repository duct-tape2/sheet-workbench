import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ExcelRuntime {
  available: boolean;
  xlwings: boolean;
  pythonPath: string;
}

export interface ExcelRecalculator {
  recalculate(filePath: string): Promise<void>;
}

const runnerPath = fileURLToPath(
  new URL("../python/excel_runner.py", import.meta.url),
);

const NATIVE_PHASES = new Set([
  "create_app",
  "configure_app",
  "record_owner",
  "open_write",
  "calculate_full_rebuild",
  "calculate",
  "save",
  "close_write",
  "reopen_readonly",
  "close_readonly",
  "complete",
]);

function nativeFailureDiagnostic(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as {
      phase?: unknown;
      errorCode?: unknown;
    };
    const phase =
      typeof parsed.phase === "string" && NATIVE_PHASES.has(parsed.phase)
        ? parsed.phase
        : undefined;
    const errorCode =
      typeof parsed.errorCode === "string" &&
      /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(parsed.errorCode)
        ? parsed.errorCode
        : undefined;
    if (phase && errorCode) return ` (phase=${phase}, code=${errorCode})`;
    if (phase) return ` (phase=${phase})`;
  } catch {
    // The bridge protocol is intentionally not echoed on parse failures.
  }
  return "";
}

async function executable(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function defaultPythonPath(cwd = process.cwd()): Promise<string> {
  const venv = path.join(
    cwd,
    ".local",
    "companion-venv",
    "Scripts",
    "python.exe",
  );
  return (await executable(venv)) ? venv : "python";
}

async function terminateOnlyOwnedExcel(
  ownerFile: string,
  token: string,
  pythonPid: number,
): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const owner = JSON.parse(await readFile(ownerFile, "utf8")) as {
      pid?: unknown;
      parent?: unknown;
      token?: unknown;
    };
    if (
      !Number.isInteger(owner.pid) ||
      (owner.pid as number) <= 0 ||
      owner.parent !== pythonPid ||
      owner.token !== token
    )
      return;
    await new Promise<void>((resolve) => {
      const taskkill = spawn(
        "taskkill",
        ["/PID", String(owner.pid), "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      taskkill.once("error", () => resolve());
      taskkill.once("close", () => resolve());
    });
  } catch {
    // No ownership record means no process is eligible for termination.
  }
}

async function runPython(
  pythonPath: string,
  args: string[],
  timeoutMs = 60_000,
  ownsExcel = false,
): Promise<string> {
  const guardDirectory = ownsExcel
    ? await mkdtemp(path.join(os.tmpdir(), "sheet-workbench-companion-excel-"))
    : undefined;
  const ownerToken = ownsExcel ? randomUUID() : undefined;
  const ownerFile = guardDirectory
    ? path.join(guardDirectory, "owned-excel.json")
    : undefined;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(
        pythonPath,
        [
          runnerPath,
          ...args,
          ...(ownerFile && ownerToken
            ? ["--owner-file", ownerFile, "--owner-token", ownerToken]
            : []),
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stdout = "";
      let settled = false;
      let timedOut = false;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        outcome();
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        void (async () => {
          // The guard file is deleted in this function's finally block. Await
          // the ownership proof and optional taskkill before rejecting so it
          // cannot race that cleanup and leave a dedicated Excel orphaned.
          if (ownerFile && ownerToken)
            await terminateOnlyOwnedExcel(
              ownerFile,
              ownerToken,
              child.pid ?? -1,
            );
          child.kill(); // This is the Python child this function spawned.
          settle(() =>
            reject(new Error("Dedicated Excel operation timed out.")),
          );
        })();
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        settle(() =>
          reject(new Error("The companion Python runtime could not start.")),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (code !== 0) {
          settle(() =>
            reject(
              new Error(
                `Dedicated Excel operation failed${nativeFailureDiagnostic(stdout)}.`,
              ),
            ),
          );
          return;
        }
        settle(() => resolve(stdout));
      });
    });
  } finally {
    if (guardDirectory)
      await rm(guardDirectory, { recursive: true, force: true });
  }
}

export async function probeExcelRuntime(
  pythonPath?: string,
): Promise<ExcelRuntime> {
  const resolved = pythonPath ?? (await defaultPythonPath());
  try {
    const output = await runPython(resolved, ["--probe"], 10_000);
    const parsed = JSON.parse(output) as { xlwings?: boolean; excel?: boolean };
    return {
      available: parsed.excel === true,
      xlwings: parsed.xlwings === true,
      pythonPath: resolved,
    };
  } catch {
    return { available: false, xlwings: false, pythonPath: resolved };
  }
}

export function dedicatedExcelRecalculator(
  pythonPath: string,
): ExcelRecalculator {
  return {
    async recalculate(filePath: string): Promise<void> {
      const output = await runPython(
        pythonPath,
        ["--recalculate", filePath],
        60_000,
        true,
      );
      const parsed = JSON.parse(output) as { ok?: boolean };
      if (!parsed.ok) throw new Error("Dedicated Excel recalculation failed.");
    },
  };
}
