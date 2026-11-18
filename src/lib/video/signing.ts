import crypto from "node:crypto";

/**
 * Firma HMAC-SHA256 de las peticiones entre la web y el transcoder (misma lógica que
 * services/transcoder/signing.mjs; hay una prueba de compatibilidad).
 *   firma = HMAC-SHA256(secreto, `${timestamp}.${nonce}.${cuerpo}`) en hexadecimal
 * Cabeceras: x-timestamp (ms), x-nonce (aleatorio, de un solo uso) y x-signature.
 */
export const MAX_SKEW_MS = 5 * 60 * 1000;

export function sign(secret: string, timestamp: string, nonce: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest("hex");
}

export function signedHeaders(secret: string, body: string, now = Date.now()): Record<string, string> {
  const timestamp = String(now);
  const nonce = crypto.randomBytes(16).toString("hex");
  return { "x-timestamp": timestamp, "x-nonce": nonce, "x-signature": sign(secret, timestamp, nonce, body) };
}

/** Comparación en tiempo constante. */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export type Verification = { ok: true; nonce: string } | { ok: false; reason: "missing" | "format" | "stale" | "signature" };

/** Verifica firma y marca de tiempo (±5 min). El nonce lo comprueba quien llama, DESPUÉS de verificar la firma. */
export function verify(secret: string, get: (name: string) => string | null, body: string, now = Date.now()): Verification {
  const timestamp = get("x-timestamp");
  const nonce = get("x-nonce");
  const signature = get("x-signature");
  if (!timestamp || !nonce || !signature) return { ok: false, reason: "missing" };
  if (!/^\d{10,16}$/.test(timestamp) || !/^[0-9a-f]{16,64}$/.test(nonce)) return { ok: false, reason: "format" };
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return { ok: false, reason: "stale" };
  if (!safeEqualHex(sign(secret, timestamp, nonce, body), signature)) return { ok: false, reason: "signature" };
  return { ok: true, nonce };
}
