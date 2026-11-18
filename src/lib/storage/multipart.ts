import "server-only";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
} from "@aws-sdk/client-s3";
import { mainBackend, type StorageBackend } from "./client";

export type UploadedPart = { partNumber: number; size: number; etag: string };

export async function createMultipart(input: { key: string; contentType: string; backend?: StorageBackend }): Promise<string> {
  const { s3, bucket } = input.backend ?? mainBackend();
  const out = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: input.key, ContentType: input.contentType }),
  );
  if (!out.UploadId) throw new Error("R2 no devolvió UploadId");
  return out.UploadId;
}

/** Partes ya recibidas por R2 (todas las páginas). Es la fuente de verdad para reanudar y completar. */
export async function listParts(input: { key: string; uploadId: string; backend?: StorageBackend }): Promise<UploadedPart[]> {
  const { s3, bucket } = input.backend ?? mainBackend();
  const parts: UploadedPart[] = [];
  let marker: string | undefined;
  for (let page = 0; page < 20; page++) {
    const out = await s3.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumberMarker: marker,
        MaxParts: 1000,
      }),
    );
    for (const part of out.Parts ?? []) {
      if (part.PartNumber && part.ETag) {
        parts.push({ partNumber: part.PartNumber, size: Number(part.Size ?? 0), etag: part.ETag });
      }
    }
    if (!out.IsTruncated || !out.NextPartNumberMarker) break;
    marker = out.NextPartNumberMarker;
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

export async function completeMultipart(input: {
  key: string;
  uploadId: string;
  parts: { partNumber: number; etag: string }[];
  backend?: StorageBackend;
}): Promise<void> {
  const { s3, bucket } = input.backend ?? mainBackend();
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: input.key,
      UploadId: input.uploadId,
      MultipartUpload: {
        Parts: input.parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );
}

export async function abortMultipart(input: { key: string; uploadId: string; backend?: StorageBackend }): Promise<void> {
  const { s3, bucket } = input.backend ?? mainBackend();
  await s3
    .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: input.key, UploadId: input.uploadId }))
    .catch(() => undefined); // ya abortada o inexistente
}

/** Tamaño real del objeto en R2 (null si no existe). */
export async function headObject(key: string, backend?: StorageBackend): Promise<{ size: number; contentType: string | null; etag: string | null } | null> {
  const { s3, bucket } = backend ?? mainBackend();
  try {
    const out = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: Number(out.ContentLength ?? 0), contentType: out.ContentType ?? null, etag: out.ETag ? out.ETag.replace(/"/g, "") : null };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw error;
  }
}

export async function deleteObject(key: string, backend?: StorageBackend): Promise<void> {
  const { s3, bucket } = backend ?? mainBackend();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Primeros bytes del objeto (lectura con Range): sirve para comprobar su firma real sin descargarlo. */
export async function readHead(key: string, length: number, backend?: StorageBackend): Promise<Uint8Array> {
  const { s3, bucket } = backend ?? mainBackend();
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${Math.max(1, length) - 1}` }));
  return (await out.Body?.transformToByteArray()) ?? new Uint8Array();
}
