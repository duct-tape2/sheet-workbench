# Security policy

Sheet Workbench is alpha software. Treat it as untrusted until the deployment owner completes the launch checklist and the live gates are verified.

## Reporting a vulnerability

Do not include secrets, tokens, real workbooks, Google Sheet IDs, or personal data in a public issue. Send a private report to the repository or deployment maintainer through the private channel they provide. Include a minimal reproduction, affected version/commit, impact, and whether the issue is reproducible on the synthetic demo. Allow time for a fix before public disclosure.

## Security boundaries

- The default personal file mode processes selected files in a browser worker, without uploading their contents. Device storage is explicitly opt-in and is not encrypted by this app; other people with access to the same browser profile can read it. Do not use shared devices for sensitive files. Browser extensions and the hosting origin remain trust boundaries.
- The separate legacy demo is synthetic and stores edits locally; neither mode is a multi-user data store.
- Real workspaces require a database and authentication. If either is missing, workspace/auth/upload routes fail closed rather than using an in-process fallback.
- State-changing API requests are checked for same-origin behavior when cookie authentication is present. A production reverse proxy must keep the browser and `/api` on one HTTPS origin.
- Viewer roles cannot write. Dataset patches use revision guards and idempotent operation IDs.
- Workspace archive export and deletion require the current owner. A signed-in archive holder may restore into a new workspace that they own; protect downloaded archives as sensitive data. Restore excludes members/auth rows and Google credentials/tokens and marks restored Google sources disconnected/read-only. Deletion requires exact workspace-name confirmation; archive before deleting.
- Google tokens are encrypted per user at rest with `GOOGLE_TOKEN_ENCRYPTION_KEY`. OAuth client secrets and database credentials belong only in the deployment secret store.
- XLSX parsing rejects legacy `.xls`, encrypted/macro-enabled workbooks, unsafe ZIP paths, external links, pivot/query features, oversized archives, and formula writes in the supported path.

## Deployment requirements

Do not expose the development Vite server or PostgreSQL directly to the Internet. Use an HTTPS same-origin reverse proxy, private database networking, generated secrets, rate limiting at the edge, and an operator-controlled backup/restore process. Do not enable Google or mail delivery until the corresponding live tests pass.

Hardened team-service deployment, live Google OAuth/Picker/writeback, Docker, mail delivery, hosted monitoring, and native Excel round-trip remain release gates. A local native PostgreSQL smoke test covered synthetic auth, XLSX import/edit/export and dump/restore; it does not establish production readiness. Exact trusted-origin configuration needs proxy-level verification. Dataset deletion and account erasure are implemented and locally tested, including last-owner protection and stale-request blocking during erasure. See [validation evidence and remaining limits](docs/LOCAL_VALIDATION.md).
