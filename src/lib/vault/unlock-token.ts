import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Token de desbloqueo del Vault (cookie `vault_unlock`). Puro y sin dependencias de Next: se prueba con `node --test`.
 *
 *  - Firmado con HMAC-SHA256 (`VAULT_COOKIE_SECRET`) y ligado a la PERSONA y a su SESIÓN de Supabase (`sid`):
 *    una cookie copiada a otra sesión u otra cuenta no vale.
 *  - Caduca a los 15 minutos SIN actividad (`act`) y, pase lo que pase, a las 2 horas de desbloquear (`iat`).
 *  - Cualquier fallo (formato, firma, caducidad, persona o sesión distintas) devuelve ok:false: el Vault falla cerrado.
 */

export const UNLOCK_IDLE_MS = 15 * 60 * 1000;
export const UNLOCK_MAX_MS = 2 * 60 * 60 * 1000;

export type UnlockPayload = {
  /** Persona */
  u: string;
  /** Sesión de Supabase (claim session_id del JWT) */
  sid: string;
  /** Momento del desbloqueo */
  iat: number;
  /** Última actividad (renovación) */
  act: number;
};

const b64 = (buffer: Buffer) => buffer.toString("base64url");

function mac(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function signUnlock(payload: UnlockPayload, secret: string): string {
  const body = b64(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64(mac(secret, body))}`;
}

export type UnlockCheck = { ok: true; payload: UnlockPayload } | { ok: false; reason: "missing" | "format" | "signature" | "owner" | "idle" | "max" };

export function verifyUnlock(
  token: string | undefined | null,
  secret: string,
  expected: { userId: string; sessionId: string },
  now = Date.now(),
): UnlockCheck {
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "format" };
  const given = Buffer.from(parts[1], "base64url");
  const want = mac(secret, parts[0]);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: "signature" };

  let payload: UnlockPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as UnlockPayload;
  } catch {
    return { ok: false, reason: "format" };
  }
  if (typeof payload.u !== "string" || typeof payload.sid !== "string" || !Number.isFinite(payload.iat) || !Number.isFinite(payload.act)) {
    return { ok: false, reason: "format" };
  }
  if (payload.u !== expected.userId || payload.sid !== expected.sessionId || !expected.sessionId) return { ok: false, reason: "owner" };
  if (now - payload.act > UNLOCK_IDLE_MS || payload.act > now + 60_000) return { ok: false, reason: "idle" };
  if (now - payload.iat > UNLOCK_MAX_MS || payload.iat > now + 60_000) return { ok: false, reason: "max" };
  return { ok: true, payload };
}

/** Renovación por actividad: mueve `act` a ahora, sin pasar nunca del máximo de 2 horas desde `iat`. */
export function renewUnlock(payload: UnlockPayload, now = Date.now()): UnlockPayload {
  return { ...payload, act: Math.min(now, payload.iat + UNLOCK_MAX_MS) };
}

/** Segundos de vida que le quedan a la cookie (para su `maxAge`). */
export function remainingSeconds(payload: UnlockPayload, now = Date.now()): number {
  const until = Math.min(payload.act + UNLOCK_IDLE_MS, payload.iat + UNLOCK_MAX_MS);
  return Math.max(0, Math.floor((until - now) / 1000));
}

// ---------------------------------------------------------------------------
// Bloqueo por intentos fallidos: 5 fallos seguidos → 15 minutos
// ---------------------------------------------------------------------------
export const MAX_UNLOCK_FAILURES = 5;
export const LOCK_MS = 15 * 60 * 1000;

export function nextFailureState(failures: number, now = Date.now()): { failures: number; lockedUntil: number | null } {
  const total = failures + 1;
  return total >= MAX_UNLOCK_FAILURES ? { failures: 0, lockedUntil: now + LOCK_MS } : { failures: total, lockedUntil: null };
}
