import { createHmac, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import type http from "node:http";

// Dependency-free auth primitives for the control plane. Everything here uses only
// node:crypto so the site runs in air-gapped / minimal images with no extra packages.
//
//   • passwords  → scrypt (salted, constant-time compare)
//   • sessions   → stateless signed cookies (HMAC-SHA256), no session store needed
//   • BYOK keys  → AES-256-GCM encrypted at rest; only a short fingerprint is exposed
//
// Secrets come from env in production; dev falls back to a fixed key so the site
// "just runs". NEVER ship the dev fallback to a real deployment — set the two vars.

const SESSION_SECRET = process.env.CAVIX_SESSION_SECRET ?? "dev-insecure-session-secret-change-me";
const SECRET_KEY = deriveKey(process.env.CAVIX_SECRET_KEY ?? "dev-insecure-encryption-secret-change-me");
const SESSION_COOKIE = "cavix_session";
const SESSION_TTL_MS = 30 * 24 * 3600_000; // 30 days

// ---------- passwords ----------

/** Hash a plaintext password: returns `salt:hash` (both hex). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Constant-time verify of a plaintext password against a stored `salt:hash`. */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------- sessions (stateless signed cookie) ----------

export interface SessionPayload {
  uid: string;
  email: string;
  org: string;
  role: string;
  exp: number; // epoch ms
}

/** Build a signed session token: base64url(payload).base64url(hmac). */
export function signSession(payload: Omit<SessionPayload, "exp">): string {
  const full: SessionPayload = { ...payload, exp: Date.now() + SESSION_TTL_MS };
  const body = b64url(JSON.stringify(full));
  const sig = b64url(createHmac("sha256", SESSION_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

/** Verify + decode a session token. Returns null if tampered or expired. */
export function verifySession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64url(createHmac("sha256", SESSION_SECRET).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** ` Secure` when the site is served over HTTPS (production), else empty. */
function secureFlag(): string {
  if (process.env.CAVIX_SECURE_COOKIES === "true") return "; Secure";
  if (process.env.CAVIX_SECURE_COOKIES === "false") return "";
  return (process.env.CAVIX_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").startsWith("https") ? "; Secure" : "";
}

/** The Set-Cookie header value that establishes a session. */
export function sessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureFlag()}`;
}

/** The Set-Cookie header value that clears the session (logout). */
export function clearCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag()}`;
}

/** Secure attribute for other short-lived cookies (e.g. the OAuth state cookie). */
export function cookieSecureAttr(): string {
  return secureFlag();
}

/** Read + verify the session from an incoming request's Cookie header. */
export function sessionFromRequest(req: http.IncomingMessage): SessionPayload | null {
  const cookies = parseCookies(req.headers.cookie);
  return verifySession(cookies[SESSION_COOKIE]);
}

/**
 * Whether an email is a platform admin (founder / core team). Controlled by the
 * CAVIX_ADMIN_EMAILS env var (comma-separated). If unset, defaults to the seeded
 * demo owner so the admin console is visible out of the box; in production, SET this
 * to your team's emails — anyone listed can manage every org's tier, trial, and limits.
 */
export function isPlatformAdmin(email: string | undefined): boolean {
  if (!email) return false;
  const raw = process.env.CAVIX_ADMIN_EMAILS ?? "demo@cavix.dev";
  const admins = raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return admins.includes(email.trim().toLowerCase());
}

/** Constant-time string equality (for comparing shared secrets / bearer tokens). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- BYOK secret storage (AES-256-GCM) ----------

/** Encrypt a raw API key for storage. Returns `iv:tag:ciphertext` (all hex). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", SECRET_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/** Decrypt a stored API key. Returns null if the blob is malformed/tampered. */
export function decryptSecret(blob: string): string | null {
  try {
    const [ivHex, tagHex, dataHex] = blob.split(":");
    if (!ivHex || !tagHex || !dataHex) return null;
    const decipher = createDecipheriv("aes-256-gcm", SECRET_KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** A short, non-reversible fingerprint of a key — safe to show in the UI/logs. */
export function fingerprint(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  const tail = key.length >= 4 ? key.slice(-4) : "";
  return `sk-…${tail} (${h.slice(0, 8)})`;
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest(); // 32 bytes for AES-256
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}
