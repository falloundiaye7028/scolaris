import crypto from "node:crypto";

export const SESSION_COOKIE = "scolaris_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

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

export function validateJsonValue(value, depth = 0) {
  if (depth > 8) throw new Error("invalid_body");
  if (typeof value === "string") {
    if (value.length > 10_000 || value.includes("\0")) throw new Error("invalid_body");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 2_000) throw new Error("invalid_body");
    value.forEach((item) => validateJsonValue(item, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("invalid_body");
      validateJsonValue(item, depth + 1);
    }
  }
}

const ROLE_PERMISSIONS = {
  owner: new Set(["students.read", "guardians.read", "billing.read", "reminders.read", "students.write", "billing.write", "payments.write", "reminders.write", "exports.read"]),
  director: new Set(["students.read", "guardians.read", "billing.read", "reminders.read", "students.write", "billing.write", "payments.write", "reminders.write", "exports.read"]),
  accountant: new Set(["students.read", "guardians.read", "billing.read", "reminders.read", "billing.write", "payments.write", "reminders.write", "exports.read"]),
  teacher: new Set(["students.read"]),
};

export function hasPermission(role, permission) {
  return Boolean(ROLE_PERMISSIONS[role]?.has(permission));
}

export function permissionFor(method, pathname) {
  if (method === "GET") {
    if (pathname.startsWith("/api/exports/")) return "exports.read";
    if (pathname.startsWith("/api/guardians")) return "guardians.read";
    if (pathname.startsWith("/api/reminders")) return "reminders.read";
    if (pathname.startsWith("/api/invoices") || pathname.startsWith("/api/payments") || pathname.startsWith("/api/receipts") || pathname.startsWith("/api/collections") || pathname.startsWith("/api/dashboard")) return "billing.read";
    return "students.read";
  }
  if (pathname.startsWith("/api/students") || pathname.startsWith("/api/guardians") || pathname.startsWith("/api/classes") || pathname.startsWith("/api/academic-years") || pathname.startsWith("/api/enrollments") || pathname.startsWith("/api/student-guardians")) return "students.write";
  if (pathname.startsWith("/api/invoices")) return "billing.write";
  if (pathname.startsWith("/api/payments")) return "payments.write";
  if (pathname.startsWith("/api/reminders") || pathname.startsWith("/api/parent-links")) return "reminders.write";
  return null;
}
