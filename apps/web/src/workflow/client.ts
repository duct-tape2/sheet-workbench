import type { WorkbookProfile as NativeProfile } from "../../../../packages/companion/src/contracts";
import type { WorkbookProfile } from "../../../../packages/workflow/src/index";
export class CompanionError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function companionAvailable() {
  return (
    ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname) &&
    document.cookie
      .split(";")
      .some((c) => c.trim().startsWith("companion_csrf="))
  );
}
export async function companion<T>(
  path: string,
  options: RequestInit = {},
  binary = false,
): Promise<T> {
  if (!companionAvailable())
    throw new Error("Open the authenticated PC companion window first.");
  const csrf =
    document.cookie
      .split(";")
      .find((c) => c.trim().startsWith("companion_csrf="))
      ?.trim()
      .slice(15) ?? "";
  const response = await fetch(`/companion/${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(120_000),
    credentials: "same-origin",
    headers: {
      ...(!options.body || options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
      "X-Companion-CSRF": decodeURIComponent(csrf),
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new CompanionError(
      error.code ?? "COMPANION_ERROR",
      error.message ?? error.error ?? `Request failed (${response.status})`,
    );
  }
  return binary ? (response.blob() as Promise<T>) : response.json();
}
export async function downloadRun(id: string) {
  const blob = await companion<Blob>(
    `runs/${encodeURIComponent(id)}/download`,
    {},
    true,
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `work-copy-${id}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function normalizeProfile(profile: NativeProfile): WorkbookProfile {
  return {
    sheets: profile.sheets.map((s) => ({
      name: s.name,
      hidden: s.hidden,
      cells: s.populatedCells,
    })),
    flags: Object.entries(profile.flags)
      .filter(([, v]) => v)
      .map(([k]) => k),
    readOnlyReasons: profile.readOnlyReasons,
  };
}
export function saveJson(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
