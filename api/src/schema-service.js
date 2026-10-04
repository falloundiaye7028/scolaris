import { readFile } from 'node:fs/promises';

const schemaFiles = ['schema.sql', 'academic-schema.sql', 'timetable-schema.sql', 'attendance-schema.sql', 'grades-schema.sql', 'fee-schema.sql', 'actor-schema.sql', 'improvements-schema.sql'];

export async function applySchema(pool) {
  const schemas = await Promise.all(schemaFiles.map(file => readFile(new URL(file, import.meta.url), 'utf8')));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Cold starts and the migration CLI must never expose an intermediate schema.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('scolaris-schema', 0))");
    for (const schema of schemas) await client.query(schema);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function createSchemaInitializer(pool) {
  let pending;
  return () => pending ||= applySchema(pool).catch(error => {
    pending = undefined;
    throw error;
  });
}
