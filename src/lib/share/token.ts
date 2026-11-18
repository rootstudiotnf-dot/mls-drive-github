import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Utilidades puras de los enlaces externos (sin Next ni base de datos: se prueban con `node --test`).
 *
 *  - El token tiene 192 bits de entropía (24 bytes aleatorios) y se muestra UNA vez; en la base de datos solo está
 *    su SHA-256. Se compara siempre en tiempo constante.
 *  - La contraseña opcional se guarda con scrypt (parámetros y sal por contraseña).
 *  - Las IPs nunca se guardan en claro: SHA-256 con una sal del servidor (`SHARE_LINK_SALT`).
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function generateToken(): string {
  return randomBytes(24).toString("base64url"); // 24 bytes → 32 caracteres
}

export function isTokenShape(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Comparación en tiempo constante de dos hashes hexadecimales. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// --- Contraseña ------------------------------------------------------------------------------------------

const SCRYPT_N = 16384;
export const MIN_PASSWORD = 6;
export const MAX_PASSWORD = 100;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N, r: 8, p: 1 });
  return `scrypt$${SCRYPT_N}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !salt || !hash || password.length > MAX_PASSWORD) return false;
  try {
    const want = Buffer.from(hash, "base64url");
    const got = scryptSync(password, Buffer.from(salt, "base64url"), want.length, { N: Number(n), r: 8, p: 1 });
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// --- Privacidad ------------------------------------------------------------------------------------------

export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

/** Navegador y sistema en una cadena corta («Chrome · Windows»). Nunca la cabecera completa. */
export function summarizeUserAgent(ua: string | null | undefined): string {
  const s = String(ua ?? "");
  const browser = /Edg\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\//.test(s) ? "Firefox" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : /bot|crawl|spider/i.test(s) ? "Robot" : "Otro";
  const os = /Windows/.test(s) ? "Windows" : /Android/.test(s) ? "Android" : /iPhone|iPad|iOS/.test(s) ? "iOS" : /Mac OS X|Macintosh/.test(s) ? "macOS" : /Linux/.test(s) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

// --- Cookie de contraseña ya validada ---------------------------------------------------------------------

/** Valor firmado `exp.firma` que prueba que esta persona introdujo la contraseña de ESTE enlace antes de `exp`. */
export function signUnlocked(linkId: string, expiresAtMs: number, key: string): string {
  const mac = createHmac("sha256", key).update(`${linkId}.${expiresAtMs}`).digest("base64url");
  return `${expiresAtMs}.${mac}`;
}

export function verifyUnlocked(value: string | undefined | null, linkId: string, key: string, now = Date.now()): boolean {
  if (!value) return false;
  const [exp, mac] = value.split(".");
  const expMs = Number(exp);
  if (!mac || !Number.isFinite(expMs) || expMs < now) return false;
  const want = createHmac("sha256", key).update(`${linkId}.${expMs}`).digest();
  const got = Buffer.from(mac, "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}

// --- Caducidad ---------------------------------------------------------------------------------------------

export const EXPIRY_CHOICES = [1, 7, 30] as const;
export type ExpiryDays = (typeof EXPIRY_CHOICES)[number];

export function isExpiryDays(value: unknown): value is ExpiryDays {
  return typeof value === "number" && (EXPIRY_CHOICES as readonly number[]).includes(value);
}

export type LinkState = "active" | "expired" | "revoked";

export function linkState(link: { revoked_at: string | null; expires_at: string }, now = Date.now()): LinkState {
  if (link.revoked_at) return "revoked";
  return Date.parse(link.expires_at) <= now ? "expired" : "active";
}
