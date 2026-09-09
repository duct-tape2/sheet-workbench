/**
 * Static builds are deliberately a synthetic, browser-only product preview.
 * Keep this flag opt-in so the local and self-hosted app retain server access.
 */
export const STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === "true";

const base = import.meta.env.BASE_URL.endsWith("/")
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;

/** Builds links that continue to work below a GitHub Pages project subpath. */
export function appHref(path = ""): string {
  return `${base}${path.replace(/^\/+/, "")}`;
}
