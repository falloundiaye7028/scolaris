import assert from "node:assert/strict";
import test from "node:test";
import {
  PLATFORM_PAYMENT_METHODS,
  SCHOOL_ACCOUNT_STATUSES,
  SUBSCRIPTION_CONFIG,
  calculateSubscriptionPeriod,
  normalizePhone,
  registrationMessage,
  schoolSlug,
  subscriptionStatusAt,
} from "../src/subscriptions.js";

test("le tarif et le délai de grâce de la plateforme sont fixes", () => {
  assert.deepEqual(SUBSCRIPTION_CONFIG, {
    name: "Abonnement SCOLARIS PAY",
    monthlyPriceXof: 50_000,
    currency: "XOF",
    billingCycle: "monthly",
    gracePeriodDays: 7,
  });
  assert.deepEqual(PLATFORM_PAYMENT_METHODS, ["cash", "wave", "orange_money", "bank_transfer", "cheque", "other"]);
  assert.ok(SCHOOL_ACCOUNT_STATUSES.includes("pending_review"));
  assert.ok(SCHOOL_ACCOUNT_STATUSES.includes("suspended"));
});

test("une période mensuelle respecte les fins de mois et enchaîne les renouvellements", () => {
  const january = calculateSubscriptionPeriod({ paidAt: "2026-01-31T10:00:00.000Z" });
  assert.equal(january.start.toISOString(), "2026-01-31T00:00:00.000Z");
  assert.equal(january.end.toISOString(), "2026-02-28T23:59:59.999Z");
  assert.equal(january.graceEnd.toISOString(), "2026-03-07T23:59:59.999Z");

  const renewal = calculateSubscriptionPeriod({ paidAt: "2026-02-15", paidUntil: january.end.toISOString() });
  assert.equal(renewal.start.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(renewal.end.toISOString(), "2026-03-31T23:59:59.999Z");
});

test("les statuts actif, grâce et suspendu sont calculés à partir des dates serveur", () => {
  const subscription = { paidUntil: "2026-08-31T23:59:59.999Z", gracePeriodEnd: "2026-09-07T23:59:59.999Z" };
  assert.equal(subscriptionStatusAt(subscription, "2026-08-30T12:00:00.000Z"), "active");
  assert.equal(subscriptionStatusAt(subscription, "2026-09-03T12:00:00.000Z"), "grace_period");
  assert.equal(subscriptionStatusAt(subscription, "2026-09-08T00:00:00.000Z"), "suspended");
  assert.equal(subscriptionStatusAt({ isExempt: true }, "2030-01-01"), "active");
});

test("l'inscription normalise les données sans révéler les doublons", () => {
  assert.equal(normalizePhone("+221 77 800 17 17"), "+221778001717");
  assert.equal(schoolSlug("École Les Étoiles !"), "ecole-les-etoiles");
  assert.throws(() => normalizePhone("123"), /invalid_body/);
  assert.doesNotMatch(registrationMessage(), /existe|doublon|déjà/i);
});
