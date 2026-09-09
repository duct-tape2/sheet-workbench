# Contributing to Sheet Workbench

Thank you for helping with the alpha. Contributions must keep this project standalone: do not copy company-site code, private spreadsheets, production identifiers, credentials, or real user data into the repository.

## Before opening a change

1. Read [IMPLEMENTATION.md](IMPLEMENTATION.md), the relevant app README, and [SECURITY.md](SECURITY.md).
2. Keep domain and authorization behavior aligned with `packages/core/src/types.ts` and the server contract.
3. Use synthetic fixtures only. Never add a real workbook or Google Sheet URL to tests, screenshots, logs, or issues.
4. Label unverified behavior as a gate or limitation instead of presenting it as a release claim.

## Local setup

```sh
npm ci
npm run dev
```

Run the full local checks before submitting:

```sh
npm run check
npm run test:e2e
```

The default tests use synthetic data, PGlite, mocked Google HTTP, and a local browser. A separate optional native PostgreSQL smoke test is documented in [native validation](docs/NATIVE_VALIDATION.md). Neither suite proves live Google OAuth/Picker/writeback, mail delivery, production HTTPS operations, or a multi-team pilot.

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Include tests for validation, authorization, concurrency, unsupported files, or responsive behavior when relevant.
- Document migrations, required environment variables, backup implications, and release gates.
- Do not add default production secrets, public write paths, or permissive CORS/trusted-origin workarounds.
- Preserve third-party license notices. Newly authored source is MIT; dependencies remain under their own licenses.

For a security issue, do not open a public issue. Follow [SECURITY.md](SECURITY.md).
