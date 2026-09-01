export function assertPreviewSeedAllowed(environment = process.env) {
  if (environment.VERCEL_ENV === "production") throw new Error("PREVIEW_SEED_FORBIDDEN_IN_PRODUCTION");
  if (environment.VERCEL !== "1" || environment.VERCEL_ENV !== "preview" || environment.SCOLARIS_ALLOW_PREVIEW_SEED !== "1") {
    throw new Error("PREVIEW_SEED_ENVIRONMENT_NOT_AUTHORIZED");
  }
}
