# Self-hosting and deployment

## What Compose provides

`compose.yaml` is an alpha trial stack:

- `app`: Node 22 image serving the built web assets and Fastify API on port 3001.
- `db`: PostgreSQL 16 with the named `postgres_data` volume.
- The app is the only published service. PostgreSQL is not published to the host.
- The Compose port binds to `127.0.0.1` so the alpha trial is not a public write surface.
- Compose requires `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL`; there are no fixed production secrets in the files.

The current development environment has no Docker CLI, so Docker/native PostgreSQL has not been run in this workspace. The image startup guard rejects missing `DATABASE_URL`, `BETTER_AUTH_SECRET`, or `BETTER_AUTH_URL`, and checks PostgreSQL before starting the app.

## Local trial

```sh
cp .env.example .env
# Replace placeholders. A portable Node generator is:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
docker compose up --build
```

Use `docker compose logs app db` for setup errors. `docker compose down` stops containers and preserves `postgres_data`. Destructive volume removal belongs in the deletion runbook.

## Production shape required before launch

Use a single HTTPS origin, for example `https://workbench.example.test`:

1. Build the web assets with `npm run build`; the production server serves `dist/web` and `/api` from one origin. Put a hardened HTTPS reverse proxy in front of it.
2. Run the Fastify server with `DATABASE_URL`, `BETTER_AUTH_SECRET`, and the HTTPS `BETTER_AUTH_URL` in a secret store.
3. Reverse-proxy only `/api` to the server. Keep PostgreSQL on a private network; do not publish port 5432.
4. Preserve the request `Host`, `Origin`, and HTTPS/proxy headers. Test sign-in, cookies, CSRF rejection, SSE events, uploads, and downloads through the public origin.
5. `BETTER_AUTH_URL` supplies the default trusted origin. For multiple explicit origins use comma-separated `TRUSTED_ORIGINS`, with no paths or wildcards. Public production origins must use HTTPS. Verify both allowed and rejected origins through the real proxy; do not disable origin checks.
6. Use an operator-controlled backup schedule and test a restore before inviting real users.

Do not use `firebase deploy`, `npm run dev`, a public database port, wildcard CORS, or a shared Google credential in production.

## Environment notes

`BETTER_AUTH_URL` is the canonical callback base. Google OAuth also needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a separate high-entropy `GOOGLE_TOKEN_ENCRYPTION_KEY`. The current Picker variables are `GOOGLE_PICKER_DEVELOPER_KEY` and `GOOGLE_APP_ID`. The OAuth scope is limited to `drive.file`, but live consent, Picker, import, refresh, and writeback remain release gates.

Email/password sign-in can run without a mail webhook in a local trial. Invitation verification delivery is not real until `EMAIL_VERIFICATION_WEBHOOK_URL` points to a deployer-operated, tested endpoint.
