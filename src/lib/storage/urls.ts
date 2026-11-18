import "server-only";

import { GetObjectCommand, PutObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mainBackend, type StorageBackend } from "./client";

/**
 * Firmado de URLs. Se llama SIEMPRE después de comprobar permisos en servidor.
 * Las URLs firmadas no se guardan ni se registran en logs.
 */
export const URL_TTL_SECONDS = {
  /** Ver (miniaturas, previsualización) */
  view: 5 * 60,
  /** Descargar */
  download: 2 * 60,
  /** PUT de una subida simple o de un derivado */
  put: 15 * 60,
  /** PUT de una parte de multipart */
  part: 60 * 60,
} as const;

export type SignedUpload = { url: string; headers: Record<string, string>; expiresIn: number };

/** URL PUT válida solo para ESTA clave y este Content-Type, 15 minutos. */
export async function signPutUrl(input: { key: string; contentType: string; ttlSeconds?: number; backend?: StorageBackend }): Promise<SignedUpload> {
  const { s3, bucket } = input.backend ?? mainBackend();
  const expiresIn = input.ttlSeconds ?? URL_TTL_SECONDS.put;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: input.key, ContentType: input.contentType }),
    { expiresIn },
  );
  return { url, headers: { "Content-Type": input.contentType }, expiresIn };
}

/** URL PUT de una parte concreta de un multipart, 1 hora. */
export async function signPartUrl(input: {
  key: string;
  uploadId: string;
  partNumber: number;
  backend?: StorageBackend;
}): Promise<{ url: string; expiresIn: number }> {
  const { s3, bucket } = input.backend ?? mainBackend();
  const url = await getSignedUrl(
    s3,
    new UploadPartCommand({
      Bucket: bucket,
      Key: input.key,
      UploadId: input.uploadId,
      PartNumber: input.partNumber,
    }),
    { expiresIn: URL_TTL_SECONDS.part },
  );
  return { url, expiresIn: URL_TTL_SECONDS.part };
}

/** `Content-Disposition: attachment` con el nombre original (ASCII + UTF-8 codificado). */
export function attachmentDisposition(filename: string): string {
  const clean = filename.replace(/[\u0000-\u001f\u007f"\\]/g, "").trim().slice(0, 200) || "descarga";
  const ascii = clean.normalize("NFKD").replace(/[^\x20-\x7e]/g, "_").replace(/[;%]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/**
 * URL GET prefirmada de vida corta. En modo descarga fuerza `attachment` con el nombre original;
 * en modo ver fuerza el Content-Type conocido (nunca se deja que el navegador lo adivine).
 * R2 atiende peticiones Range, así que audio y vídeo funcionan con `<audio>`/`<video>` nativos.
 */
export async function signGetUrl(input: {
  key: string;
  mode: "view" | "download";
  contentType?: string;
  filename?: string;
  ttlSeconds?: number;
  backend?: StorageBackend;
}): Promise<{ url: string; expiresIn: number }> {
  const { s3, bucket } = input.backend ?? mainBackend();
  const expiresIn = input.ttlSeconds ?? (input.mode === "download" ? URL_TTL_SECONDS.download : URL_TTL_SECONDS.view);
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: input.key,
      ResponseContentType: input.contentType,
      ResponseContentDisposition:
        input.mode === "download" ? attachmentDisposition(input.filename ?? "descarga") : undefined,
    }),
    { expiresIn },
  );
  return { url, expiresIn };
}
