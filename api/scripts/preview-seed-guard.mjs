export function assertPreviewSeedAllowed(environment = process.env) {
  if (environment.VERCEL_ENV === "production") throw new Error("PREVIEW_SEED_FORBIDDEN_IN_PRODUCTION");
  if (environment.VERCEL !== "1" || environment.VERCEL_ENV !== "preview" || environment.SCOLARIS_ALLOW_PREVIEW_SEED !== "1") {
    throw new Error("PREVIEW_SEED_ENVIRONMENT_NOT_AUTHORIZED");
  }
}

export async function assertPreviewDatabaseIdentity(client, environment = process.env) {
  assertPreviewSeedAllowed(environment);
  const expectedFingerprint = String(environment.SCOLARIS_PREVIEW_DATABASE_FINGERPRINT || "");
  if (!/^[A-Fa-f0-9]{32,128}$/.test(expectedFingerprint)) throw new Error("PREVIEW_SEED_EXPECTED_DATABASE_IDENTITY_MISSING");
  let rows;
  try {
    ({ rows } = await client.query("SELECT environment,resource_fingerprint FROM deployment_environment_identity WHERE singleton=true"));
  } catch {
    throw new Error("PREVIEW_SEED_DATABASE_IDENTITY_UNAVAILABLE");
  }
  if (rows.length !== 1) throw new Error("PREVIEW_SEED_DATABASE_IDENTITY_MISSING");
  const identity = rows[0];
  if (identity.environment === "production") throw new Error("PREVIEW_SEED_DATABASE_IDENTIFIED_AS_PRODUCTION");
  if (identity.environment !== "preview") throw new Error("PREVIEW_SEED_DATABASE_IDENTITY_NOT_PREVIEW");
  if (String(identity.resource_fingerprint).toLowerCase() !== expectedFingerprint.toLowerCase()) {
    throw new Error("PREVIEW_SEED_DATABASE_RESOURCE_MISMATCH");
  }
}
