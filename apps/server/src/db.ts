import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { backgroundFailure } from "./log.ts";

type Row = { data: Record<string, unknown> };
interface Database {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  close: () => Promise<void>;
}

export class Store {
  constructor(private readonly db: Database) {}
  async get<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    id: string,
  ): Promise<T | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id",
      [owner, kind],
    );
    return result.rows.map((row) => row.data as T);
  }
  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return value;
  }
  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [
      owner,
      kind,
      id,
    ]);
  }
  async compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
    // JSONB containment allows extra nested keys; delegated control needs equality.
    exactDelegation = false,
  ): Promise<T | null> {
    const result = await this.db.query(
      `UPDATE records SET data=data || $5::jsonb,updated_at=now() WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb${exactDelegation ? " AND data->'delegation' = $4::jsonb->'delegation'" : ""} RETURNING data`,
      [owner, kind, id, JSON.stringify(expected), JSON.stringify(patch)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null> {
    const result = await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async reserveDelegatedRetry<T extends { id: string }>(
    owner: string,
    sourceTaskId: string,
    rootTaskId: string,
    expectedTaskId: string,
    reservation: T,
  ): Promise<T | null> {
    const result = await this.db.query(
      `WITH source AS (
         SELECT data FROM records WHERE owner=$1 AND kind='tasks' AND id=$2
         AND data->>'status' IN ('failed','outcome_unknown')
         AND NOT (data->>'status'='outcome_unknown'
           AND COALESCE(data->'delegation'->>'terminal','')='finished')
         AND COALESCE(data->>'retryRootTaskId',id)=$3
         FOR UPDATE
       )
       INSERT INTO records(owner,kind,id,data)
       SELECT $1,'delegated-retries',$3,$5::jsonb FROM source
       WHERE NOT EXISTS (
         SELECT 1 FROM records action WHERE action.owner=$1 AND action.kind='actions'
         AND action.id=source.data->>'actionId'
         AND action.data->>'status' IN ('awaiting_review','executing','outcome_unknown')
       )
       ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()
       WHERE records.data->>'taskId'=$4
       RETURNING data`,
      [owner, sourceTaskId, rootTaskId, expectedTaskId, JSON.stringify(reservation)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async scan<T>(kind: string): Promise<{ owner: string; value: T }[]> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC",
      [kind],
    );
    return result.rows.map((row) => row.data as { owner: string; value: T });
  }
  async claim<T>(owner: string, id: string, status: string, now: string): Promise<T | null> {
    const result = await this.db.query(
      `UPDATE records AS action SET data=jsonb_set(data,'{status}',$4::jsonb),updated_at=now()
       WHERE owner=$1 AND kind='actions' AND id=$2 AND data->>'status'='awaiting_review'
       AND (data->>'expiresAt')::timestamptz>$3::timestamptz
       AND ($4::jsonb <> '"executing"'::jsonb OR
         (action.data->>'kind'<>'file.replace_text' AND action.data->>'taskId' IS NULL) OR EXISTS (
         SELECT 1 FROM records task WHERE task.owner=action.owner AND task.kind='tasks'
         AND task.id=action.data->>'taskId' AND (
           (action.data->>'kind'<>'file.replace_text'
            AND task.data->>'status' IN ('running','waiting_approval')) OR
           (action.data->>'kind'='file.replace_text' AND task.data->>'kind'='openbot'
            AND task.data->>'status'='succeeded' AND task.data->>'actionId'=action.id
            AND task.data->'delegation'->>'readMode'='direct'
            AND task.data->'delegation'->>'replacementIntent'='reviewed_replace_text'
            AND task.data->'delegation'->>'runId'=action.data->>'sourceRunId'
            AND task.data->'delegation'->>'resourcePath'=action.data->'data'->>'path'
            AND NOT EXISTS (
              SELECT 1 FROM records retry WHERE retry.owner=task.owner AND retry.kind='delegated-retries'
              AND retry.id=COALESCE(task.data->>'retryRootTaskId',task.id)
              AND retry.data->>'taskId'<>task.id
            ))
         )
       )) RETURNING data`,
      [owner, id, now, JSON.stringify(status)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async claimLocalFile(owner: string, resourceId: string, actionId: string): Promise<boolean> {
    const value = { id: resourceId, actionId, status: "executing" };
    const result = await this.db.query(
      `INSERT INTO records(owner,kind,id,data)
       SELECT $1,'local-file-claims',$2,$4::jsonb
       WHERE EXISTS (SELECT 1 FROM records action WHERE action.owner=$1 AND action.kind='actions'
         AND action.id=$3 AND action.data->>'status'='executing')
       ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()
       WHERE records.data->>'status' <> 'executing'
       RETURNING data`,
      [owner, resourceId, actionId, JSON.stringify(value)],
    );
    return result.rows.length === 1;
  }
  async recoverInterruptedActions(): Promise<void> {
    await this.db.query(
      `UPDATE records SET data=data || '{"status":"outcome_unknown","error":"Server restarted during execution. Check the provider before creating another action."}'::jsonb WHERE kind='actions' AND data->>'status'='executing'`,
    );
  }
  async take<T>(owner: string, kind: string, id: string): Promise<T | null> {
    const result = await this.db.query(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3 RETURNING data",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  close(): Promise<void> {
    return this.db.close();
  }
  async updateCredential(owner: string, connectionId: string, secret: string): Promise<boolean> {
    const result = await this.db.query(
      "UPDATE records SET data=jsonb_set(data,'{secret}',$3::jsonb),updated_at=now() WHERE owner=$1 AND kind='credentials' AND id='google' AND data->>'connectionId'=$2 RETURNING data",
      [owner, connectionId, JSON.stringify(secret)],
    );
    return result.rows.length === 1;
  }
}

/** Idle clients can be disconnected by a database restart; without a listener pg's `error` event crashes the process. */
export function createPool(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  pool.on("error", (error) => backgroundFailure("postgres pool", error));
  return pool;
}

export async function createStore(
  options: { dataDir?: string; databaseUrl?: string } = {},
): Promise<Store> {
  let database: Database;
  if (options.databaseUrl) {
    const pool = createPool(options.databaseUrl);
    database = { query: async (sql, params) => pool.query(sql, params), close: () => pool.end() };
  } else {
    if (options.dataDir) await mkdir(dirname(options.dataDir), { recursive: true, mode: 0o700 });
    const embedded = new PGlite(options.dataDir);
    await embedded.waitReady;
    database = {
      query: (sql, params) => embedded.query<Row>(sql, params),
      close: () => embedded.close(),
    };
  }
  await database.query(
    "CREATE TABLE IF NOT EXISTS records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))",
  );
  return new Store(database);
}
