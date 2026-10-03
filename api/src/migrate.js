import { applySchema } from './schema-service.js';
import pg from 'pg';
const databaseUrl = new URL(process.env.DATABASE_URL || 'postgres://scolaris:scolaris_dev@localhost:5432/scolaris');
if (['prefer', 'require', 'verify-ca'].includes(databaseUrl.searchParams.get('sslmode'))) databaseUrl.searchParams.set('sslmode', 'verify-full');
const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
try {
  await applySchema(pool);
  console.log('Migration SCOLARIS terminée');
} finally {
  await pool.end();
}
