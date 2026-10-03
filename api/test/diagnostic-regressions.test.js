import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { zipSync, strToU8 } from 'fflate';
import http from 'node:http';
import { readJsonBody } from '../src/request-body.js';
import { readImportArchive } from '../src/import-archive.js';
import { createSchemaInitializer } from '../src/schema-service.js';
import { schoolAccessStatus } from '../src/subscriptions.js';
import { financialStatus } from '../src/fee-service.js';
import { permissionFor, hasPermission, quoteCsv } from '../src/security.js';
import { createWebServer } from '../../web/server.js';

const requestBody = (chunks, type = 'application/json') => Object.assign(Readable.from(chunks), { headers: { 'content-type': type } });

test('JSON: conserve les accents coupés entre deux paquets et refuse les corps non objets', async () => {
  const bytes = Buffer.from('{"name":"École"}');
  const split = bytes.indexOf(0xc3) + 1;
  assert.deepEqual(await readJsonBody(requestBody([bytes.subarray(0, split), bytes.subarray(split)])), { name: 'École' });
  for (const value of ['null', '[]', '42', '"texte"', '{']) await assert.rejects(readJsonBody(requestBody([value])), /invalid_body/);
  await assert.rejects(readJsonBody(requestBody(['{}'], 'application/json-invalid')), /unsupported_media/);
  await assert.rejects(readJsonBody(requestBody(['{"name":"École"}']), { maxBytes: 10 }), /body_too_large/);
});

test('JSON: accepte les fichiers base64 autorisés au-delà de 10 000 caractères', async () => {
  const data = { fileBase64: Buffer.alloc(20_000).toString('base64') };
  assert.deepEqual(await readJsonBody(requestBody([JSON.stringify(data)]), { maxStringLength: 4_194_304 }), data);
  await assert.rejects(readJsonBody(requestBody([JSON.stringify(data)])), /invalid_body/);
});

test('XLSX: borne la décompression avant allocation et refuse les composants actifs', () => {
  assert.equal(Buffer.from(readImportArchive(zipSync({ 'xl/workbook.xml': strToU8('<workbook/>') }))['xl/workbook.xml']).toString(), '<workbook/>');
  assert.throws(() => readImportArchive(zipSync({ 'xl/worksheets/large.xml': new Uint8Array(20 * 1024 * 1024 + 1) })), /invalid_import_archive/);
  assert.throws(() => readImportArchive(zipSync({ 'xl/vbaProject.bin': new Uint8Array(1) })), /invalid_import_archive/);
  const entries = Object.fromEntries(Array.from({ length: 301 }, (_, i) => [String(i), new Uint8Array()]));
  assert.throws(() => readImportArchive(zipSync(entries)), /invalid_import_archive/);
});

test('migration: partage un seul démarrage, annule un échec et autorise une nouvelle tentative', async () => {
  const commands = [];
  let fail = true, connections = 0, releases = 0;
  const pool = { async connect() { connections++; return { async query(sql) { commands.push(sql); if (sql.startsWith('CREATE EXTENSION') && fail) { fail = false; throw Error('temporary_database_failure'); } }, release() { releases++; } }; } };
  const initialize = createSchemaInitializer(pool);
  const first = initialize();
  assert.equal(first, initialize());
  await assert.rejects(first, /temporary_database_failure/);
  assert.equal(commands.at(-1), 'ROLLBACK');
  await initialize();
  await initialize();
  assert.equal(commands.at(-1), 'COMMIT');
  assert.equal(connections, 2);
  assert.equal(releases, 2);
  assert.match(commands[1], /pg_advisory_xact_lock/);
});

test('abonnement: applique immédiatement les échéances et conserve une suspension manuelle', () => {
  const row = { subscription_status: 'active', paid_until: '2026-10-01', grace_period_end: '2026-10-08' };
  assert.equal(schoolAccessStatus(row, new Date('2026-10-03')), 'grace_period');
  assert.equal(schoolAccessStatus(row, new Date('2026-10-10')), 'suspended');
  assert.equal(schoolAccessStatus({ ...row, subscription_status: 'suspended' }, new Date('2026-09-01')), 'suspended');
  assert.equal(schoolAccessStatus({ ...row, subscription_status: 'pending_review' }), 'pending_review');
  assert.equal(schoolAccessStatus({ ...row, is_exempt: true }), 'active');
});

test('une remise totale solde la facture et les contacts parents restent réservés', () => {
  assert.equal(financialStatus({ amountDueXof: 0, amountPaidXof: 0 }), 'paid');
  assert.equal(hasPermission('teacher', permissionFor('GET', '/api/student-guardians')), false);
  for (const text of ['  =SUM(A1)', '\n+SUM(A1)', '\t@command']) assert.match(quoteCsv(text), /^"'/);
});

test('serveur web local: transmet les API, cookies et routes privées sur la même origine', async context => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'test=1; HttpOnly' });
    res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie, origin: req.headers['x-forwarded-host'] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => upstream.close(resolve)));
  const web = createWebServer({ apiPort: upstream.address().port });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => web.close(resolve)));
  const base = `http://127.0.0.1:${web.address().port}`;
  const response = await fetch(`${base}/api/me`, { headers: { cookie: 'session=test' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), 'test=1; HttpOnly');
  assert.deepEqual(await response.json(), { path: '/api/me', cookie: 'session=test', origin: `127.0.0.1:${web.address().port}` });
  assert.equal((await (await fetch(`${base}/app`)).json()).path, '/app');
  assert.equal((await fetch(`${base}/og-scolaris-pay.png`)).status, 200);
  assert.equal((await fetch(`${base}/connexion`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${base}/unknown`)).status, 404);
});
