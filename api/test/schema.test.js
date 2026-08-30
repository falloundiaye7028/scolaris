import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../src/schema.sql", import.meta.url), "utf8");

test("la migration de sécurité est additive et révocable", () => {
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS sessions/);
  assert.match(schema, /revoked_at timestamptz/);
  assert.match(schema, /expires_at timestamptz NOT NULL/);
  assert.match(schema, /token_hash text/);
  assert.match(schema, /absolute_expires_at timestamptz/);
  assert.match(schema, /reauthenticated_at timestamptz/);
});

test("la récupération, la MFA et les événements sont persistés sans secret brut", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS password_reset_tokens/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS user_mfa/);
  assert.match(schema, /secret_ciphertext text NOT NULL/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mfa_recovery_codes/);
  assert.match(schema, /code_hash text NOT NULL/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS security_events/);
});

test("la limitation de connexion est persistée en base", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS login_attempts/);
  assert.match(schema, /locked_until timestamptz/);
});
