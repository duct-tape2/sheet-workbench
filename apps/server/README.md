# Sheet Workbench server

The Fastify server is deliberately database-backed. If `DATABASE_URL` is not
available at startup, it still provides `GET /api/config` for the browser demo,
but every workspace, upload, dataset, and auth route fails closed. It never
falls back to an in-process workspace store.

Required for real workspaces:

```text
DATABASE_URL=postgres://…
BETTER_AUTH_SECRET=<random secret of at least 32 characters>
BETTER_AUTH_URL=http://localhost:3001
```

Trusted origins default to the configured auth URL origin. Optional
`TRUSTED_ORIGINS` is a comma-separated exact-origin allowlist. Paths and
wildcards are rejected, and public production origins must use HTTPS.

`npm run start` runs the idempotent schema bootstrap before listening on port
3001 (override with `PORT`/`HOST`). Put migrations under operator control in a
production rollout rather than relying on a first web request.

Google Sheets is intentionally unavailable until all of these are supplied:

```text
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
GOOGLE_TOKEN_ENCRYPTION_KEY=<separate high-entropy key>
```

Tokens are encrypted per user at rest. Writeback checks Drive `canEdit`, the
stored immutable row identity, each edited-cell preimage, and the post-write
value. An uncertain source row is rejected; it is never reported as saved.
The only configured Google scope is `drive.file`; the service does not request
broad spreadsheet access.

Email/password sign-in works without mail delivery, but accepting an invitation
always requires a verified email. To make verification deliverable, a deployer
may configure `EMAIL_VERIFICATION_WEBHOOK_URL`; the server POSTs the recipient
and one-time verification URL to that deployer-operated endpoint. It does not
pretend to send verification mail if no delivery endpoint is configured.

Before public release, verify an actual PostgreSQL deployment, mail delivery,
the live Google OAuth consent/callback and writeback path, and a multi-user
three-team pilot. The repository tests use PGlite and mocked Google HTTP only.
