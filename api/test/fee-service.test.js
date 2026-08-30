import assert from "node:assert/strict";
import test from "node:test";
import { FEE_TYPE_LABELS, financialStatus, xofFromMinor } from "../src/fee-service.js";

test("les identifiants techniques des catégories restent stables", () => {
  assert.deepEqual(FEE_TYPE_LABELS, {
    tuition: "Mensualité",
    registration: "Frais d’inscription",
    uniform: "Tenue scolaire",
    transport: "Transport",
    other: "Autre",
  });
});

test("les statuts financiers sont calculés depuis le dû et le payé", () => {
  assert.equal(financialStatus({ amountDueXof: 25_000, amountPaidXof: 0 }), "unpaid");
  assert.equal(financialStatus({ amountDueXof: 25_000, amountPaidXof: 10_000 }), "partially_paid");
  assert.equal(financialStatus({ amountDueXof: 25_000, amountPaidXof: 25_000 }), "paid");
  assert.equal(financialStatus({ amountDueXof: 25_000, amountPaidXof: 0, exempted: true }), "exempted");
  assert.equal(financialStatus({ amountDueXof: 25_000, amountPaidXof: 0, cancelled: true }), "cancelled");
});

test("la compatibilité historique n’accepte que des XOF entiers", () => {
  assert.equal(xofFromMinor(10_000), 100);
  assert.throws(() => xofFromMinor(10_050), /invalid_body/);
  assert.throws(() => xofFromMinor(0), /invalid_body/);
});
