import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../src/schema.sql", import.meta.url), "utf8");

test("la migration de sécurité est additive et révocable", () => {
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS sessions/);
  assert.match(schema, /revoked_at timestamptz/);
  assert.match(schema, /expires_at timestamptz NOT NULL/);
});

test("la limitation de connexion est persistée en base", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS login_attempts/);
  assert.match(schema, /locked_until timestamptz/);
});
