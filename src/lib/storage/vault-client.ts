import "server-only";

import { S3Client } from "@aws-sdk/client-s3";
import { getVaultR2Config } from "@/lib/env";
import type { StorageBackend } from "./client";
import { isUuid, sanitizeFilename } from "./keys";

/**
 * Cliente S3 del bucket del VAULT, con su propio token de API (R2_VAULT_*). Es el ÚNICO sitio que lo crea:
 * el código del Vault pasa `vaultBackend()` a las funciones de firmado y multipart. Ni este token toca el bucket
 * normal ni el token normal toca este bucket (Cloudflare limita cada token a su bucket).
 *
 * TTL de las URLs del Vault (mucho más cortos que los del espacio normal): ver 2 min · descargar 60 s.
 */
let cached: S3Client | null = null;

function vaultS3(): S3Client {
  if (cached) return cached;
  const config = getVaultR2Config();
  cached = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return cached;
}

export function vaultBackend(): StorageBackend {
  return { s3: vaultS3(), bucket: getVaultR2Config().bucket };
}

export const VAULT_URL_TTL_SECONDS = { view: 120, download: 60 } as const;

/** Clave de un objeto del Vault: identificador opaco e inmutable (sin artista ni carpeta: mover no renombra). */
export function buildVaultKey(assetId: string, filename: string): string {
  if (!isUuid(assetId)) throw new Error("assetId no válido");
  return `vault/${assetId}/original/${sanitizeFilename(filename)}`;
}
