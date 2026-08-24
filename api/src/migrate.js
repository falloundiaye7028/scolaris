import { readFile } from 'node:fs/promises';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://scolaris:scolaris_dev@localhost:5432/scolaris' });
await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
console.log('Migration SCOLARIS terminée');
await pool.end();
