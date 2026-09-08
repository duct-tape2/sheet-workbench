/**
 * The small SQL surface used by the server.  `pg.Pool`, `pg.PoolClient`, and
 * PGlite all satisfy it, which keeps tests on a real Postgres-compatible
 * engine without smuggling an in-memory repository into production.
 */
export interface SqlResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface SqlClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
}

interface ReleasableSqlClient extends SqlClient {
  release(): void;
}

interface ConnectableSqlClient extends SqlClient {
  connect(): Promise<ReleasableSqlClient>;
}

function isConnectable(db: SqlClient): db is ConnectableSqlClient {
  return typeof (db as Partial<ConnectableSqlClient>).connect === "function";
}

/** Execute a transaction against a pg Pool/Client or PGlite instance. */
export async function inTransaction<T>(
  db: SqlClient,
  work: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  const connected = isConnectable(db) ? await db.connect() : undefined;
  const tx: SqlClient = connected ?? db;
  try {
    await tx.query("BEGIN");
    const result = await work(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await tx.query("ROLLBACK");
    } catch {
      // Preserve the original error. A failed rollback only matters to logs.
    }
    throw error;
  } finally {
    connected?.release();
  }
}

export function asJson(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}
