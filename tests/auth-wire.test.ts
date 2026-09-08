import { it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { createServer } from "../apps/server/src/server";
import { migrate } from "../apps/server/src/schema";

it("actual Better Auth password/session path works through pg driver without test identity injection", async () => {
  const db = await PGlite.create();
  const wire = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });
  await wire.start();
  const pool = new Pool({
    connectionString: `postgresql://postgres@${wire.getServerConn()}/postgres`,
    max: 1,
  });
  await migrate(pool);
  const baseURL = "http://localhost:3001";
  const app = createServer({
    db: pool,
    authConfig: {
      secret: randomBytes(48).toString("base64url"),
      baseURL,
      trustedOrigins: [baseURL],
    },
  });
  await app.ready();
  try {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin: baseURL, host: "localhost:3001" },
      payload: {
        name: "Synthetic Auth Tester",
        email: "synthetic-auth@example.test",
        password: "Long-unique-test-password-8264",
      },
    });
    expect(signup.statusCode, signup.body).toBe(200);
    const cookies = (
      Array.isArray(signup.headers["set-cookie"])
        ? signup.headers["set-cookie"]
        : [signup.headers["set-cookie"]]
    )
      .filter(Boolean)
      .map((v) => String(v).split(";")[0])
      .join("; ");
    expect(cookies).toContain("session_token");
    const session = await app.inject({
      url: "/api/auth/get-session",
      headers: { cookie: cookies, host: "localhost:3001" },
    });
    expect(session.statusCode, session.body).toBe(200);
    expect(session.json().user.email).toBe("synthetic-auth@example.test");
    const workspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: cookies, origin: baseURL },
      payload: { name: "Private workspace" },
    });
    expect(workspace.statusCode, workspace.body).toBe(200);
    const signout = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { cookie: cookies, origin: baseURL, host: "localhost:3001" },
      payload: {},
    });
    expect(signout.statusCode, signout.body).toBe(200);
    const denied = await app.inject({
      url: "/api/workspaces",
      headers: { cookie: cookies },
    });
    expect(denied.statusCode).toBe(401);
  } finally {
    await app.close();
    await pool.end();
    await wire.stop();
    await db.close();
  }
}, 30000);
