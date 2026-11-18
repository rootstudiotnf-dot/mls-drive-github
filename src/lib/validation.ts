/** Validación manual de entradas en servidor (sin librerías). Devuelven null si no es válido. */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 72; // límite de bcrypt (bytes)

function asString(value: FormDataEntryValue | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export function parseEmail(value: FormDataEntryValue | null | undefined): string | null {
  const raw = asString(value)?.trim().toLowerCase();
  if (!raw || raw.length > 254 || !EMAIL_RE.test(raw)) return null;
  return raw;
}

export function parseName(value: FormDataEntryValue | null | undefined): string | null {
  const raw = asString(value)?.replace(/\s+/g, " ").trim();
  if (!raw || raw.length < 2 || raw.length > 80 || /[\u0000-\u001f\u007f]/.test(raw)) {
    return null;
  }
  return raw;
}

export function parsePassword(value: FormDataEntryValue | null | undefined): string | null {
  const raw = asString(value);
  if (raw === null || raw.length < PASSWORD_MIN) return null;
  if (new TextEncoder().encode(raw).length > PASSWORD_MAX) return null;
  return raw;
}

export function parseUuid(value: FormDataEntryValue | null | undefined): string | null {
  const raw = asString(value);
  return raw && UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

export function parseRoleKey(value: FormDataEntryValue | null | undefined): string | null {
  const raw = asString(value);
  return raw && ROLE_KEY_RE.test(raw) ? raw : null;
}

/** Solo rutas internas: evita redirecciones abiertas (`//evil.com`, `https://…`, `/\evil`). */
export function safeNextPath(value: string | null | undefined, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }
  if (value.startsWith("/auth/")) return fallback;
  return value;
}
