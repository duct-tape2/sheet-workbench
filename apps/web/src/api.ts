import { STATIC_DEMO } from "./environment";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public payload: unknown,
  ) {
    super(message);
  }
}
export async function api<T = unknown>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  if (STATIC_DEMO)
    throw new ApiError(
      503,
      "The public demo is browser-only. Self-host the app to use server features.",
      null,
    );
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: "include",
    headers:
      body instanceof FormData ? {} : { "Content-Type": "application/json" },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("json")
    ? await response.json()
    : await response.text();
  if (!response.ok)
    throw new ApiError(
      response.status,
      (typeof payload === "object" &&
        payload &&
        (payload.message || payload.error?.message || payload.error)) ||
        `Request failed (${response.status})`,
      payload,
    );
  return payload as T;
}
async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
function responseErrorMessage(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload) {
    const value = payload as {
      message?: unknown;
      error?: { message?: unknown } | unknown;
    };
    if (typeof value.message === "string") return value.message;
    if (
      typeof value.error === "object" &&
      value.error &&
      typeof (value.error as { message?: unknown }).message === "string"
    )
      return (value.error as { message: string }).message;
    if (typeof value.error === "string") return value.error;
  }
  if (typeof payload === "string" && payload) return payload;
  return `Request failed (${status})`;
}
export async function downloadFromApi(
  path: string,
  name: string,
  type = "application/octet-stream",
): Promise<void> {
  if (STATIC_DEMO)
    throw new ApiError(
      503,
      "The browser-only public demo cannot download server-managed files.",
      null,
    );
  const response = await fetch(`/api${path}`, { credentials: "include" });
  if (!response.ok) {
    const payload = await responsePayload(response);
    throw new ApiError(
      response.status,
      responseErrorMessage(payload, response.status),
      payload,
    );
  }
  download(await response.blob(), name, type);
}
export function download(
  content: BlobPart,
  name: string,
  type = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  try {
    a.href = url;
    a.download = name;
    a.setAttribute("aria-hidden", "true");
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
export function getLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
export function setLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* restricted storage: remain functional */
  }
}
