import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import staticFiles from "@fastify/static";
import { Pool } from "pg";
import { createServer } from "./server.ts";
import { migrate } from "./schema.ts";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
const builtWebRoot = resolve(
  process.env.WEB_DIST_DIR ??
    fileURLToPath(new URL("../../../dist/web", import.meta.url)),
);

async function start(): Promise<void> {
  let pool: Pool | undefined;
  if (process.env.DATABASE_URL) {
    const candidate = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    });
    try {
      await migrate(candidate);
      pool = candidate;
    } catch (error) {
      // A misconfigured or unavailable database must not turn into an
      // in-memory workspace server. The UI can still serve its browser demo,
      // and every real-data endpoint remains fail-closed.
      console.error(
        "Sheet Workbench started without database access:",
        error instanceof Error ? error.message : "database startup failed",
      );
      await candidate.end().catch(() => undefined);
    }
  } else {
    console.warn(
      "DATABASE_URL is not set; Sheet Workbench is running in browser-demo-only mode.",
    );
  }

  const app = createServer({ db: pool, logger: true });
  if (existsSync(resolve(builtWebRoot, "index.html"))) {
    await app.register(staticFiles, {
      root: builtWebRoot,
      prefix: "/",
      // The plugin's global cache option would also cache index.html. Let the
      // explicit header policy below make only Vite's fingerprinted assets
      // immutable, while the shell always revalidates after a deployment.
      cacheControl: false,
      allowedPath: (pathName) => !pathName.startsWith("/api/"),
      setHeaders: (reply, path) => {
        const normalized = path.replaceAll("\\", "/");
        const fingerprintedAsset =
          /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs|woff2?|ttf|otf|svg|png|jpe?g|webp|avif)$/i.test(
            normalized,
          );
        reply.header(
          "cache-control",
          fingerprintedAsset
            ? "public, max-age=2592000, immutable"
            : "no-store",
        );
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply
          .status(404)
          .send({ code: "NOT_FOUND", message: "API route was not found." });
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return reply
          .header("cache-control", "no-store")
          .type("text/html; charset=utf-8")
          .sendFile("index.html", { cacheControl: false });
      }
      return reply
        .status(404)
        .send({ code: "NOT_FOUND", message: "Route was not found." });
    });
  } else {
    console.warn(
      `Web build not found at ${builtWebRoot}; only the API/browser demo is available.`,
    );
  }
  const shutdown = async () => {
    await app.close();
    await pool?.end();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  await app.listen({ port, host });
}

start().catch((error) => {
  console.error(
    "Sheet Workbench failed to start:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
