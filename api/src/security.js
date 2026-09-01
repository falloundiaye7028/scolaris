import crypto from "node:crypto";

export const SESSION_COOKIE = "scolaris_session";
export const SESSION_IDLE_SECONDS = 30 * 60;
export const SESSION_ABSOLUTE_SECONDS = 8 * 60 * 60;
export const SESSION_TTL_SECONDS = SESSION_ABSOLUTE_SECONDS;
export const SESSION_LIMIT_PER_USER = 5;

export function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        const key = index < 0 ? part : part.slice(0, index);
        const value = index < 0 ? "" : part.slice(index + 1);
        try {
          return [key, decodeURIComponent(value)];
        } catch {
          return [key, ""];
        }
      }),
  );
}

export function sessionCookie(token, { secure = true } = {}) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie({ secure = true } = {}) {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");
}

export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase().slice(0, 254);
}

export function clientAddress(req) {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

export function opaqueDigest(value, secret) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex");
}

export function loginAttemptKey(req, email, secret) {
  return opaqueDigest(`${clientAddress(req)}\n${normalizeEmail(email)}`, secret);
}

export function loginAttemptKeys(req, email, secret) {
  const address = clientAddress(req);
  const normalizedEmail = normalizeEmail(email);
  const device = String(req.headers["user-agent"] ?? "").slice(0, 512);
  return {
    account: `account:${opaqueDigest(normalizedEmail, secret)}`,
    address: `address:${opaqueDigest(address, secret)}`,
    device: `device:${opaqueDigest(`${address}\n${device}`, secret)}`,
    combined: `combined:${opaqueDigest(`${address}\n${normalizedEmail}\n${device}`, secret)}`,
  };
}

export function newOpaqueToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function isOpaqueSessionToken(value) {
  return /^[A-Za-z0-9_-]{43}$/.test(String(value ?? ""));
}

export function isAllowedBrowserOrigin(req, allowedOrigins = []) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
    const protocol = String(req.headers["x-forwarded-proto"] || "https");
    const sameOrigin = `${protocol}://${host}`;
    return origin === sameOrigin || allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function safeCsvValue(value) {
  const text = String(value ?? "").replaceAll("\0", "");
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function quoteCsv(value) {
  return `"${safeCsvValue(value).replaceAll('"', '""')}"`;
}

export function validateJsonValue(value, depth = 0, { maxStringLength = 10_000 } = {}) {
  if (depth > 8) throw new Error("invalid_body");
  if (typeof value === "string") {
    if (value.length > maxStringLength || value.includes("\0")) throw new Error("invalid_body");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 2_000) throw new Error("invalid_body");
    value.forEach((item) => validateJsonValue(item, depth + 1, { maxStringLength }));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("invalid_body");
      validateJsonValue(item, depth + 1, { maxStringLength });
    }
  }
}

export function safeText(value, { min = 0, max = 255, pattern } = {}) {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max || text.includes("\0") || (pattern && !pattern.test(text))) {
    throw new Error("invalid_body");
  }
  return text;
}

export function positiveInteger(value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error("invalid_body");
  return number;
}

export function pagination(searchParams, { defaultLimit = 100, maxLimit = 200 } = {}) {
  const limit = positiveInteger(searchParams.get("limit") || defaultLimit, { min: 1, max: maxLimit });
  const offset = Number(searchParams.get("offset") || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error("invalid_body");
  return { limit, offset };
}

export function hasSpreadsheetFormula(value) {
  return /^[=+\-@\t\r]/.test(String(value ?? "").replace(/^ +/, ""));
}

const ROLE_PERMISSIONS = {
  owner: new Set(["students.read", "guardians.read", "billing.read", "reminders.read", "students.write", "billing.write", "fee_definitions.write", "fee_adjustments.write", "uniform_delivery.write", "payments.write", "reminders.write", "exports.read", "timetable.read", "timetable.manage", "rooms.read", "rooms.manage", "lesson_sessions.read", "lesson_sessions.manage", "attendance.read", "attendance.mark", "attendance.update", "attendance.justify", "attendance.reports"]),
  director: new Set(["students.read", "guardians.read", "billing.read", "reminders.read", "students.write", "billing.write", "fee_definitions.write", "fee_adjustments.write", "uniform_delivery.write", "payments.write", "reminders.write", "exports.read", "timetable.read", "timetable.manage", "rooms.read", "rooms.manage", "lesson_sessions.read", "lesson_sessions.manage", "attendance.read", "attendance.mark", "attendance.update", "attendance.justify", "attendance.reports"]),
  accountant: new Set(["students.read", "guardians.read", "billing.read", "reminders.read", "billing.write", "payments.write", "reminders.write", "exports.read"]),
  teacher: new Set(["students.read", "timetable.read", "lesson_sessions.read", "attendance.read", "attendance.mark", "attendance.update", "attendance.justify"]),
};

export function hasPermission(role, permission) {
  return Boolean(ROLE_PERMISSIONS[role]?.has(permission));
}

export function permissionFor(method, pathname) {
  if (method === "GET") {
    if (pathname.startsWith("/api/attendance/reports")) return "attendance.reports";
    if (pathname.startsWith("/api/attendance") || pathname.startsWith("/api/academic-periods")) return "attendance.read";
    if (pathname.startsWith("/api/exports/")) return "exports.read";
    if (pathname.startsWith("/api/rooms")) return "rooms.read";
    if (pathname.startsWith("/api/lesson-sessions")) return "lesson_sessions.read";
    if (pathname.startsWith("/api/timetable-entries") || pathname.startsWith("/api/teaching-assignments") || pathname.startsWith("/api/subjects") || pathname.startsWith("/api/teachers")) return "timetable.read";
    if (/^\/api\/students\/[^/]+\/statement$/.test(pathname)) return "billing.read";
    if (pathname.startsWith("/api/guardians")) return "guardians.read";
    if (pathname.startsWith("/api/reminders")) return "reminders.read";
    if (pathname.startsWith("/api/invoices") || pathname.startsWith("/api/fee-") || pathname.startsWith("/api/uniform-assignments") || pathname.startsWith("/api/reports/fees") || pathname.startsWith("/api/payments") || pathname.startsWith("/api/student-payments") || pathname.startsWith("/api/student-fee-payments") || pathname.startsWith("/api/receipts") || pathname.startsWith("/api/collections") || pathname.startsWith("/api/dashboard")) return "billing.read";
    return "students.read";
  }
  if (pathname.startsWith("/api/attendance/justifications")) return "attendance.justify";
  if (/^\/api\/attendance\/sessions\/[^/]+\/records$/.test(pathname)) return "attendance.mark";
  if (pathname.startsWith("/api/academic-periods")) return "attendance.update";
  if (pathname.startsWith("/api/rooms")) return "rooms.manage";
  if (pathname.startsWith("/api/lesson-sessions")) return "lesson_sessions.manage";
  if (pathname.startsWith("/api/timetable-entries") || pathname.startsWith("/api/teaching-assignments") || pathname.startsWith("/api/subjects")) return "timetable.manage";
  if (pathname.startsWith("/api/students") || pathname.startsWith("/api/guardians") || pathname.startsWith("/api/classes") || pathname.startsWith("/api/academic-years") || pathname.startsWith("/api/enrollments") || pathname.startsWith("/api/student-guardians")) return "students.write";
  if (pathname.startsWith("/api/fee-categories") || pathname.startsWith("/api/fee-definitions") || pathname.startsWith("/api/fee-assignments/preview") || pathname.startsWith("/api/fee-assignments/bulk")) return "fee_definitions.write";
  if (/^\/api\/fee-assignments\/[^/]+\/adjust$/.test(pathname) || /^\/api\/student-payments\/[^/]+\/cancel$/.test(pathname)) return "fee_adjustments.write";
  if (pathname.startsWith("/api/uniform-assignments")) return "uniform_delivery.write";
  if (pathname.startsWith("/api/invoices")) return "billing.write";
  if (pathname.startsWith("/api/payments") || pathname.startsWith("/api/student-fee-payments")) return "payments.write";
  if (pathname.startsWith("/api/reminders") || pathname.startsWith("/api/parent-links")) return "reminders.write";
  return null;
}
