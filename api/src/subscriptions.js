const MONTHLY_PRICE_XOF = Number(process.env.SCOLARIS_MONTHLY_PRICE_XOF || 50_000);
const GRACE_PERIOD_DAYS = Number(process.env.SCOLARIS_GRACE_PERIOD_DAYS || 7);

if (MONTHLY_PRICE_XOF !== 50_000) throw new Error("SCOLARIS_MONTHLY_PRICE_XOF doit être égal à 50000");
if (!Number.isInteger(GRACE_PERIOD_DAYS) || GRACE_PERIOD_DAYS !== 7) throw new Error("SCOLARIS_GRACE_PERIOD_DAYS doit être égal à 7");

export const SUBSCRIPTION_CONFIG = Object.freeze({
  name: "Abonnement SCOLARIS PAY",
  monthlyPriceXof: MONTHLY_PRICE_XOF,
  currency: "XOF",
  billingCycle: "monthly",
  gracePeriodDays: GRACE_PERIOD_DAYS,
});

export const SCHOOL_TYPES = Object.freeze([
  "public",
  "private",
  "community",
  "religious",
  "vocational",
  "higher_education",
  "other",
]);

export const PLATFORM_PAYMENT_METHODS = Object.freeze([
  "cash",
  "wave",
  "orange_money",
  "bank_transfer",
  "cheque",
  "other",
]);

export const SCHOOL_ACCOUNT_STATUSES = Object.freeze([
  "pending_email",
  "pending_review",
  "pending_payment",
  "active",
  "grace_period",
  "suspended",
  "rejected",
  "cancelled",
]);

export const ACTIVE_SCHOOL_STATUSES = new Set(["active"]);
export const READ_ONLY_SCHOOL_STATUSES = new Set(["grace_period", "suspended"]);
export const PENDING_SCHOOL_STATUSES = new Set(["pending_email", "pending_review", "pending_payment", "rejected", "cancelled"]);

export function normalizePhone(value) {
  const source = String(value ?? "").trim();
  const leadingPlus = source.startsWith("+");
  const digits = source.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) throw new Error("invalid_body");
  return `${leadingPlus ? "+" : ""}${digits}`;
}

export function schoolSlug(name) {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 84) || "ecole";
}

export function utcStartOfDay(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_body");
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcMonthsClamped(value, months) {
  const date = utcStartOfDay(value);
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

export function calculateSubscriptionPeriod({ paidUntil, paidAt = new Date(), requestedStart } = {}) {
  const paymentDay = utcStartOfDay(paidAt);
  let start;
  if (paidUntil && new Date(paidUntil).getTime() >= paymentDay.getTime()) {
    start = utcStartOfDay(paidUntil);
    start.setUTCDate(start.getUTCDate() + 1);
  } else {
    start = requestedStart ? utcStartOfDay(requestedStart) : paymentDay;
  }
  const nextMonth = addUtcMonthsClamped(start, 1);
  const clampedToShorterMonth = nextMonth.getUTCDate() < start.getUTCDate();
  const end = new Date(nextMonth.getTime() + (clampedToShorterMonth ? 86_400_000 : 0) - 1);
  const graceEnd = new Date(end.getTime() + SUBSCRIPTION_CONFIG.gracePeriodDays * 86_400_000);
  return { start, end, graceEnd };
}

export function subscriptionStatusAt({ paidUntil, gracePeriodEnd, isExempt = false }, now = new Date()) {
  if (isExempt) return "active";
  const instant = new Date(now).getTime();
  if (!paidUntil) return "pending_payment";
  if (new Date(paidUntil).getTime() >= instant) return "active";
  if (gracePeriodEnd && new Date(gracePeriodEnd).getTime() >= instant) return "grace_period";
  return "suspended";
}

export function registrationMessage() {
  return "Si les informations peuvent être enregistrées, les instructions de confirmation seront envoyées.";
}
