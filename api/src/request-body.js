import { validateJsonValue } from './security.js';

export async function readJsonBody(req, { maxBytes = 4_500_000, ...validationOptions } = {}) {
  const mediaType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') throw Error('unsupported_media');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw Error('body_too_large');
    chunks.push(bytes);
  }
  let parsed;
  try { parsed = size ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) : {}; }
  catch { throw Error('invalid_body'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('invalid_body');
  validateJsonValue(parsed, 0, validationOptions);
  return parsed;
}
