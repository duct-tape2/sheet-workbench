/** Loopback-only synthetic team trial. Production uses native PostgreSQL/Compose. */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool } from "pg";
import staticPlugin from "@fastify/static";
import { createServer } from "../apps/server/src/server.ts";
import { migrate } from "../apps/server/src/schema.ts";
import { setupNeeded } from "../apps/server/src/errors.ts";

const root = resolve(import.meta.dirname, "..");
const storage = resolve(root, ".local", "team-trial");
await mkdir(storage, { recursive: true });
const secretPath = resolve(storage, "auth-secret");
let secret: string;
try {
  secret = (await readFile(secretPath, "utf8")).trim();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  secret = randomBytes(48).toString("base64url");
  await writeFile(secretPath, secret, { mode: 0o600, flag: "wx" });
}
const db = await PGlite.create(resolve(storage, "database"));
const wire = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });
await wire.start();
const pool = new Pool({
  connectionString: `postgresql://postgres@${wire.getServerConn()}/postgres`,
  max: 1,
});
await migrate(pool);
const base = "http://127.0.0.1:3002";
const noGoogle = async () => {
  throw setupNeeded(
    "This local trial has no Google connection. Use the synthetic XLSX samples.",
  );
};
const app = createServer({
  db: pool,
  authConfig: {
    secret,
    baseURL: base,
    trustedOrigins: [base],
    verificationWebhookURL: "",
    passwordResetWebhookURL: "",
  },
  trustedOrigins: [base],
  storageLabel:
    "Local synthetic team trial · this computer · no Google connection",
  google: {
    credentials: {
      enabled: () => false,
      begin: noGoogle,
      complete: noGoogle,
      accessToken: noGoogle,
    },
  },
});
await app.register(staticPlugin, { root: resolve(root, "dist", "web") });
await app.listen({ host: "127.0.0.1", port: 3002 });
console.log(
  `TEAM_TRIAL_READY ${base} — synthetic samples only; data stays in .local/team-trial; Ctrl+C stops the server.`,
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await pool.end();
  await wire.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
