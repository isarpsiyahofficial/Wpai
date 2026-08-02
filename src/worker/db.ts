export type D1Value = string | number | null | ArrayBuffer;

export async function first<T>(db: D1Database, sql: string, ...values: D1Value[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...values).first<T>()) ?? null;
}

export async function all<T>(db: D1Database, sql: string, ...values: D1Value[]): Promise<T[]> {
  const result = await db.prepare(sql).bind(...values).all<T>();
  if (!result.success) throw new Error('DATABASE_QUERY_FAILED');
  return result.results;
}

export async function run(db: D1Database, sql: string, ...values: D1Value[]): Promise<D1Result> {
  const result = await db.prepare(sql).bind(...values).run();
  if (!result.success) throw new Error('DATABASE_WRITE_FAILED');
  return result;
}

export function nowIso(): string { return new Date().toISOString(); }

export async function audit(
  db: D1Database,
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
  summary: Record<string, unknown>,
  requestId: string
): Promise<void> {
  await run(
    db,
    `INSERT INTO audit_logs (id, actor_admin_id, action, target_type, target_id, summary_json, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(), actorId, action, targetType, targetId, JSON.stringify(summary), requestId, nowIso()
  );
}

export async function setting(db: D1Database, key: string): Promise<string | null> {
  const row = await first<{ value_json: string }>(db, 'SELECT value_json FROM system_settings WHERE key = ? LIMIT 1', key);
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.value_json);
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
  } catch { return row.value_json; }
}

export async function setSetting(db: D1Database, key: string, value: unknown, actorId?: string): Promise<void> {
  await run(
    db,
    `INSERT INTO system_settings (key, value_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    key, JSON.stringify(value), nowIso(), actorId ?? null
  );
}
