/**
 * Recupera trabajos de vídeo y audio atascados.
 *
 *   npm run requeue-media-jobs
 *
 * Reenvía al servicio de procesado los trabajos 'queued' o 'processing' con más de 30 minutos (máximo 3
 * intentos; después quedan 'failed' con constancia). Pensado para ejecutarse desde un cron cada 10-15 min.
 *
 * Este script NO tiene credenciales de R2 ni de Supabase: llama a la web (`/api/internal/video-requeue`) firmando la
 * petición con el mismo secreto HMAC del servicio, y es la web —que ya tiene las claves— quien genera las URLs.
 *
 * Variables (de .env.local): NEXT_PUBLIC_SITE_URL y TRANSCODER_HMAC_SECRET.
 * Requiere Node 22.18+ (ejecuta TypeScript directamente); solo usa sintaxis borrable.
 */
import { signedHeaders } from "../src/lib/video/signing.ts";

const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
const secret = process.env.TRANSCODER_HMAC_SECRET ?? "";
if (!site || secret.length < 32) {
  console.error("Faltan NEXT_PUBLIC_SITE_URL o TRANSCODER_HMAC_SECRET (mínimo 32 caracteres) en .env.local.");
  process.exit(1);
}

const body = "{}";
const response = await fetch(`${site}/api/internal/video-requeue`, {
  method: "POST",
  headers: { "content-type": "application/json", ...signedHeaders(secret, body) },
  body,
  signal: AbortSignal.timeout(120_000),
});
if (!response.ok) {
  console.error(`La web respondió ${response.status}.`);
  process.exit(1);
}
const result = (await response.json()) as { retried: number; exhausted: number; examined: number };
console.log(`Trabajos examinados: ${result.examined} · reenviados: ${result.retried} · fallo definitivo (3 intentos): ${result.exhausted}`);
