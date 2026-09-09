import type { Locale } from "../../../packages/core/src/types";

/** Explicit language links win; invalid or old stored values never break UI text. */
export function initialLocale(
  search: string,
  saved: unknown,
  language: string,
): Locale {
  const requested = new URLSearchParams(search).get("lang");
  if (requested === "en" || requested === "ko") return requested;
  if (saved === "en" || saved === "ko") return saved;
  return /^ko(?:-|$)/i.test(language) ? "ko" : "en";
}
