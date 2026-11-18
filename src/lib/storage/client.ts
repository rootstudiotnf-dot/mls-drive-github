import "server-only";

import { S3Client } from "@aws-sdk/client-s3";
import { getR2Config } from "@/lib/env";

/**
 * Cliente S3 de Cloudflare R2. SOLO servidor (`server-only`): las credenciales nunca llegan al navegador.
 * El navegador no usa este cliente: sube y descarga directamente contra R2 con URLs prefirmadas.
 */
let cached: S3Client | null = null;

export function getS3(): S3Client {
  if (cached) return cached;
  const config = getR2Config();
  cached = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // R2 no admite los checksums opcionales que el SDK añade por defecto a las URLs prefirmadas
    // (un navegador no puede calcularlos): se piden solo cuando una operación los exige.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return cached;
}

/** Un bucket y el cliente S3 con credenciales para ESE bucket. El bucket normal es el valor por defecto de todo. */
export type StorageBackend = { s3: S3Client; bucket: string };

export function mainBackend(): StorageBackend {
  return { s3: getS3(), bucket: getBucket() };
}

export function getBucket(): string {
  return getR2Config().bucket;
}
