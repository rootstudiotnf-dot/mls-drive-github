/**
 * Lectura de variables de entorno con error claro si faltan.
 * Las NEXT_PUBLIC_* deben referenciarse literalmente para que Next las incruste en el cliente.
 * SUPABASE_SERVICE_ROLE_KEY y OWNER_EMAIL son SOLO de servidor: no se leen en código de cliente.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Falta la variable de entorno ${name}. Revisa .env.local (ver .env.example y docs/SETUP-SUPABASE.md).`,
    );
  }
  return value;
}

export function getSupabaseUrl(): string {
  return required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
}

export function getSupabaseAnonKey(): string {
  return required(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/** URL pública de la plataforma, sin barra final (para los enlaces de los correos). */
export function getSiteUrl(): string {
  return required("NEXT_PUBLIC_SITE_URL", process.env.NEXT_PUBLIC_SITE_URL).replace(
    /\/+$/,
    "",
  );
}

/** Solo servidor. */
export function getServiceRoleKey(): string {
  return required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ---------------------------------------------------------------------------
// Almacenamiento (Cloudflare R2). Todo esto es SOLO de servidor: nunca lleva prefijo NEXT_PUBLIC_.
// ---------------------------------------------------------------------------

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Endpoint S3. Por defecto el de R2; R2_ENDPOINT permite apuntar a un S3 local (MinIO) en desarrollo. */
  endpoint: string;
};

export function getR2Config(): R2Config {
  const accountId = required("R2_ACCOUNT_ID", process.env.R2_ACCOUNT_ID);
  return {
    accountId,
    accessKeyId: required("R2_ACCESS_KEY_ID", process.env.R2_ACCESS_KEY_ID),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY", process.env.R2_SECRET_ACCESS_KEY),
    bucket: required("R2_BUCKET", process.env.R2_BUCKET),
    endpoint:
      process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`La variable de entorno ${name} debe ser un número mayor que 0.`);
  }
  return value;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Tamaño máximo de una subida, en bytes (MAX_UPLOAD_GB, por defecto 10). */
export function getMaxUploadBytes(): number {
  return Math.floor(positiveNumber("MAX_UPLOAD_GB", process.env.MAX_UPLOAD_GB, 10) * GIB);
}

/** Tamaño de parte del multipart, en bytes (UPLOAD_PART_SIZE_MB, por defecto 16, mínimo 5). */
export function getPartSizeBytes(): number {
  const mb = positiveNumber("UPLOAD_PART_SIZE_MB", process.env.UPLOAD_PART_SIZE_MB, 16);
  return Math.floor(Math.max(5, mb) * MIB);
}

/** Precio por GB-mes (R2_PRICE_PER_GB_MONTH) para estimar costes. */
export function getPricePerGbMonth(): number {
  return positiveNumber("R2_PRICE_PER_GB_MONTH", process.env.R2_PRICE_PER_GB_MONTH, 0.015);
}

// ---------------------------------------------------------------------------
// Procesado de vídeo (servicio transcoder). SOLO servidor.
// ---------------------------------------------------------------------------

export type TranscoderConfig = { url: string; secret: string; maxDurationMin: number };

/** null si el servicio no está configurado: los vídeos quedan en cola hasta que lo esté. */
export function getTranscoderConfig(): TranscoderConfig | null {
  const url = process.env.TRANSCODER_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.TRANSCODER_HMAC_SECRET?.trim();
  if (!url || !secret || secret.length < 32) return null;
  const minutes = Number(process.env.VIDEO_MAX_DURATION_MIN ?? 120);
  return { url, secret, maxDurationMin: Number.isFinite(minutes) && minutes > 0 ? minutes : 120 };
}

/** Secreto para verificar los callbacks y la petición de reintento (mismo que el del servicio). */
export function getTranscoderSecret(): string | null {
  const secret = process.env.TRANSCODER_HMAC_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

// ---------------------------------------------------------------------------
// Vault (Fase 8). SOLO servidor. Bucket y token de API PROPIOS: el token del espacio normal no toca el Vault
// y el del Vault no toca el espacio normal.
// ---------------------------------------------------------------------------

export type VaultR2Config = { accessKeyId: string; secretAccessKey: string; bucket: string; endpoint: string };

/** Lanza si falta algo: sin configuración del Vault, todo el Vault falla cerrado. */
export function getVaultR2Config(): VaultR2Config {
  const accountId = required("R2_ACCOUNT_ID", process.env.R2_ACCOUNT_ID);
  return {
    accessKeyId: required("R2_VAULT_ACCESS_KEY_ID", process.env.R2_VAULT_ACCESS_KEY_ID),
    secretAccessKey: required("R2_VAULT_SECRET_ACCESS_KEY", process.env.R2_VAULT_SECRET_ACCESS_KEY),
    bucket: required("R2_VAULT_BUCKET", process.env.R2_VAULT_BUCKET),
    endpoint: process.env.R2_VAULT_ENDPOINT?.trim() || process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

/** ¿Está el Vault configurado (bucket y token propios)? */
export function isVaultConfigured(): boolean {
  return Boolean(process.env.R2_VAULT_ACCESS_KEY_ID && process.env.R2_VAULT_SECRET_ACCESS_KEY && process.env.R2_VAULT_BUCKET);
}

/** Secreto (≥ 32 caracteres) con el que se firma la cookie de desbloqueo del Vault. null si falta → el Vault no abre. */
export function getVaultCookieSecret(): string | null {
  const secret = process.env.VAULT_COOKIE_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

// ---------------------------------------------------------------------------
// Colaboración (Fase 9). SOLO servidor.
// ---------------------------------------------------------------------------

/** Sal/clave del servidor para hashear IPs y firmar cookies y enlaces de baja (≥ 32 caracteres). null si falta. */
export function getShareSalt(): string | null {
  const value = process.env.SHARE_LINK_SALT?.trim();
  return value && value.length >= 32 ? value : null;
}

/** Secreto del cron de avisos (Authorization: Bearer …). null si falta → el endpoint no responde. */
export function getCronSecret(): string | null {
  const value = process.env.CRON_SECRET?.trim();
  return value && value.length >= 16 ? value : null;
}

export type MailConfig = { apiKey: string; from: string; url: string };

/** Envío por la API HTTP de Resend con fetch. null si no está configurado: los avisos siguen en la bandeja interna. */
export function getMailConfig(): MailConfig | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (!apiKey || !from) return null;
  return { apiKey, from, url: process.env.RESEND_API_URL?.trim() || "https://api.resend.com/emails" };
}
