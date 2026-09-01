import assert from "node:assert/strict";
import test from "node:test";
import { assertPreviewSeedAllowed } from "../scripts/preview-seed-guard.mjs";

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
