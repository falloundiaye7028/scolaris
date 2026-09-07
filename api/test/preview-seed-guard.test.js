import assert from "node:assert/strict";
import test from "node:test";
import { assertPreviewDatabaseIdentity, assertPreviewSeedAllowed } from "../scripts/preview-seed-guard.mjs";

const previewEnvironment = {
  VERCEL: "1",
  VERCEL_ENV: "preview",
  SCOLARIS_ALLOW_PREVIEW_SEED: "1",
  SCOLARIS_PREVIEW_DATABASE_FINGERPRINT: "a".repeat(64),
};

test("le seed refuse explicitement la Production", () => {
  assert.throws(
    () => assertPreviewSeedAllowed({ VERCEL: "1", VERCEL_ENV: "production", SCOLARIS_ALLOW_PREVIEW_SEED: "1" }),
    /PREVIEW_SEED_FORBIDDEN_IN_PRODUCTION/,
  );
});

for (const environment of [
  { VERCEL: "1", VERCEL_ENV: "development", SCOLARIS_ALLOW_PREVIEW_SEED: "1" },
  { VERCEL: "1", VERCEL_ENV: "preview" },
  { VERCEL: "1", VERCEL_ENV: "preview", SCOLARIS_ALLOW_PREVIEW_SEED: "0" },
  { VERCEL_ENV: "preview", SCOLARIS_ALLOW_PREVIEW_SEED: "1" },
  { VERCEL: "1", SCOLARIS_ALLOW_PREVIEW_SEED: "1" },
]) {
  test(`le seed refuse l'environnement non autorisé ${JSON.stringify(environment)}`, () => {
    assert.throws(() => assertPreviewSeedAllowed(environment), /PREVIEW_SEED_ENVIRONMENT_NOT_AUTHORIZED/);
  });
}

test("le seed accepte uniquement la combinaison Preview explicite", () => {
  assert.doesNotThrow(() => assertPreviewSeedAllowed({ VERCEL: "1", VERCEL_ENV: "preview", SCOLARIS_ALLOW_PREVIEW_SEED: "1" }));
});

test("la garde refuse une Preview Vercel connectée à une base identifiée Production", async () => {
  const client = { query: async () => ({ rows: [{ environment: "production", resource_fingerprint: "a".repeat(64) }] }) };
  await assert.rejects(assertPreviewDatabaseIdentity(client, previewEnvironment), /PREVIEW_SEED_DATABASE_IDENTIFIED_AS_PRODUCTION/);
});

test("la garde échoue sans identité persistée, pour une identité inconnue ou une ressource différente", async () => {
  await assert.rejects(assertPreviewDatabaseIdentity({ query: async () => ({ rows: [] }) }, previewEnvironment), /IDENTITY_MISSING/);
  await assert.rejects(
    assertPreviewDatabaseIdentity({ query: async () => ({ rows: [{ environment: "staging", resource_fingerprint: "a".repeat(64) }] }) }, previewEnvironment),
    /IDENTITY_NOT_PREVIEW/,
  );
  await assert.rejects(
    assertPreviewDatabaseIdentity({ query: async () => ({ rows: [{ environment: "preview", resource_fingerprint: "b".repeat(64) }] }) }, previewEnvironment),
    /RESOURCE_MISMATCH/,
  );
});

test("la garde accepte uniquement l'identité Preview et l'empreinte attendue lues sur la connexion", async () => {
  const queries = [];
  const client = { query: async (sql) => { queries.push(sql); return { rows: [{ environment: "preview", resource_fingerprint: "A".repeat(64) }] }; } };
  await assert.doesNotReject(assertPreviewDatabaseIdentity(client, previewEnvironment));
  assert.deepEqual(queries, ["SELECT environment,resource_fingerprint FROM deployment_environment_identity WHERE singleton=true"]);
});
