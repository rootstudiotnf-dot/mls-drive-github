// Firma HMAC-SHA256 de las peticiones entre la web y el transcoder (en ambos sentidos).
//   firma = HMAC-SHA256(secreto, `${timestamp}.${nonce}.${cuerpo}`) en hexadecimal
// Cabeceras: x-timestamp (ms desde epoch), x-nonce (aleatorio, de un solo uso), x-signature.
// Solo librería estándar. La misma lógica vive en src/lib/video/signing.ts (la web); hay una prueba de compatibilidad.
import crypto from "node:crypto";

export const MAX_SKEW_MS = 5 * 60 * 1000;

export function sign(secret, timestamp, nonce, body) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest("hex");
}

export function signedHeaders(secret, body, now = Date.now()) {
  const timestamp = String(now);
  const nonce = crypto.randomBytes(16).toString("hex");
  return { "x-timestamp": timestamp, "x-nonce": nonce, "x-signature": sign(secret, timestamp, nonce, body) };
}

/** Comparación en tiempo constante (longitudes distintas = rechazo sin comparar byte a byte). */
export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * Verifica firma y marca de tiempo. El nonce (anti-repetición) lo comprueba quien llama, DESPUÉS de verificar
 * la firma, para que un atacante sin secreto no pueda llenar el almacén de nonces.
 */
export function verify(secret, headers, body, now = Date.now()) {
  const timestamp = headers["x-timestamp"];
  const nonce = headers["x-nonce"];
  const signature = headers["x-signature"];
  if (typeof timestamp !== "string" || typeof nonce !== "string" || typeof signature !== "string") return { ok: false, reason: "missing" };
  if (!/^\d{10,16}$/.test(timestamp) || !/^[0-9a-f]{16,64}$/.test(nonce)) return { ok: false, reason: "format" };
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return { ok: false, reason: "stale" };
  if (!safeEqualHex(sign(secret, timestamp, nonce, body), signature)) return { ok: false, reason: "signature" };
  return { ok: true, nonce };
}

/** Almacén de nonces vistos (en memoria, con caducidad algo mayor que la tolerancia de la marca de tiempo). */
export class NonceStore {
  constructor(ttlMs = 2 * MAX_SKEW_MS) {
    this.ttlMs = ttlMs;
    this.seen = new Map();
  }
  /** true si es nuevo (y lo registra); false si ya se usó. */
  use(nonce, now = Date.now()) {
    for (const [key, at] of this.seen) if (now - at > this.ttlMs) this.seen.delete(key);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now);
    return true;
  }
}
