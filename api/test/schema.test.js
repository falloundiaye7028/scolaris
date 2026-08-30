import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../src/schema.sql", import.meta.url), "utf8");
const feeSchema = await readFile(new URL("../src/fee-schema.sql", import.meta.url), "utf8");

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

test("les inscriptions et abonnements des établissements ont un modèle dédié", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS school_email_confirmations/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS registration_attempts/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS school_subscriptions/);
  assert.match(schema, /monthly_price_xof integer NOT NULL DEFAULT 50000 CHECK\(monthly_price_xof=50000\)/);
  assert.match(schema, /billing_cycle text NOT NULL DEFAULT 'monthly' CHECK\(billing_cycle='monthly'\)/);
  assert.match(schema, /grace_period_end timestamptz/);
  assert.doesNotMatch(schema, /UPDATE users SET is_platform_admin=true/);
});

test("les règlements plateforme restent physiquement séparés des paiements scolaires", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS platform_subscription_payments/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS platform_payment_proofs/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS subscription_notifications/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS payments/);
  assert.match(schema, /CREATE OR REPLACE VIEW student_fee_payments/);
  assert.match(schema, /amount_expected_xof integer NOT NULL CHECK\(amount_expected_xof=50000\)/);
  assert.match(schema, /cancellation_reason text/);
  assert.doesNotMatch(schema, /ON DELETE CASCADE[\s\S]{0,80}platform_subscription_payments/);
});

test("les frais scolaires ont une migration additive annuelle et sans montants flottants", () => {
  assert.match(feeSchema, /CREATE TABLE IF NOT EXISTS fee_categories/);
  assert.match(feeSchema, /CREATE TABLE IF NOT EXISTS fee_definitions/);
  assert.match(feeSchema, /fee_type IN \('tuition','registration','uniform','transport','other'\)/);
  assert.match(feeSchema, /amount_xof bigint NOT NULL/);
  assert.match(feeSchema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_once_per_year/);
  assert.match(feeSchema, /CREATE TABLE IF NOT EXISTS uniform_fee_items/);
  assert.match(feeSchema, /delivery_status IN \('not_applicable','to_prepare','available','delivered'\)/);
  assert.match(feeSchema, /CREATE TABLE IF NOT EXISTS uniform_delivery_events/);
  assert.match(feeSchema, /CREATE TABLE IF NOT EXISTS fee_adjustments/);
  assert.match(feeSchema, /CREATE TABLE IF NOT EXISTS student_payment_batches/);
  assert.match(feeSchema, /CREATE TABLE IF NOT EXISTS student_payment_allocations/);
  assert.match(feeSchema, /amount_expected_xof_snapshot bigint/);
  assert.match(feeSchema, /total_paid_after_xof bigint/);
  assert.match(feeSchema, /balance_after_xof bigint/);
  assert.doesNotMatch(feeSchema, /\b(?:real|double precision|numeric\s*\([^)]*,)/i);
});

test("les paiements scolaires ventilés restent séparés des abonnements plateforme", () => {
  assert.match(feeSchema, /student_payment_batches/);
  assert.match(feeSchema, /student_payment_allocations/);
  assert.match(feeSchema, /CREATE OR REPLACE VIEW student_fee_payments/);
  assert.doesNotMatch(feeSchema, /student_payment_(?:batches|allocations)[\s\S]{0,200}platform_subscription_payments/);
});
