# Alpha self-hosting image. The final image keeps the TypeScript runtime because
# the server currently starts through tsx; production hardening is a release gate.
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app .
USER node

EXPOSE 3001
CMD ["sh", "-c", "test -n \"$DATABASE_URL\" && test -n \"$BETTER_AUTH_SECRET\" && test -n \"$BETTER_AUTH_URL\" || { echo 'DATABASE_URL, BETTER_AUTH_SECRET, and BETTER_AUTH_URL are required.' >&2; exit 78; }; case \"$DATABASE_URL:$BETTER_AUTH_SECRET\" in *replace-me*) echo 'Replace placeholder secrets before starting the app.' >&2; exit 78;; esac; node --input-type=module -e \"import pg from 'pg'; const pool = new pg.Pool({connectionString: process.env.DATABASE_URL}); await pool.query('SELECT 1'); await pool.end();\" || exit 78; exec npm run start"]
