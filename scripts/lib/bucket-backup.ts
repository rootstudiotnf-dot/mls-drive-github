/**
 * Copia incremental de un bucket de R2 a un bucket de copia (lo comparten `backup-files` y `backup-vault`).
 * Un objeto cuenta como ya copiado si en la copia existe con el mismo tamaño y el mismo ETag de origen (metadato
 * `src-etag`). Los archivos NO pasan por el servidor web: esto se ejecuta donde decidas (tu máquina o una tarea
 * programada). Sin dependencias nuevas; solo sintaxis borrable (Node 22.18+ ejecuta TypeScript directamente).
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

const SINGLE_PUT_MAX = 4 * 1024 * 1024 * 1024; // por debajo de 5 GiB (límite de un PUT)
const PART_SIZE = 64 * 1024 * 1024;

export const env = (name: string): string => process.env[name]?.trim() || "";
export function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

export type BucketBackupOptions = {
  /** Nombre en los mensajes: «Archivos» o «Vault». */
  label: string;
  kind: "files" | "vault";
  /** Prefijo que se añade a la clave en el destino (así dos orígenes pueden compartir el mismo bucket de copia). */
  targetPrefix: string;
  /** Prefijo que se lee en el origen y se quita al copiar (restauración desde la copia). */
  sourcePrefix?: string;
  source: { bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string };
  /** Por defecto, el bucket de copia (R2_BACKUP_*). En una restauración, el bucket nuevo. */
  target?: { bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string };
  /** Dónde se anota el resultado (kind de backup_runs); null = no se anota (restauraciones). */
  record?: boolean;
  dryRun: boolean;
};

const client = (endpoint: string, key: string, secret: string) =>
  new S3Client({ region: "auto", endpoint, forcePathStyle: true, credentials: { accessKeyId: key, secretAccessKey: secret }, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });

type Item = { key: string; size: number; etag: string };

export async function runBucketBackup(options: BucketBackupOptions): Promise<never> {
  const accountId = env("R2_ACCOUNT_ID");
  const record = options.record !== false;
  const dest = options.target ?? { bucket: env("R2_BACKUP_BUCKET"), endpoint: env("R2_BACKUP_ENDPOINT") || env("R2_ENDPOINT") || `https://${accountId}.r2.cloudflarestorage.com`, accessKeyId: env("R2_BACKUP_ACCESS_KEY_ID"), secretAccessKey: env("R2_BACKUP_SECRET_ACCESS_KEY") };
  const backupBucket = dest.bucket;
  for (const name of record ? ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] : []) {
    if (!env(name)) stop(`Falta ${name} en .env.local.`);
  }
  if (!dest.accessKeyId || !dest.secretAccessKey) stop("Faltan las credenciales del bucket de destino.");
  const source = client(options.source.endpoint, options.source.accessKeyId, options.source.secretAccessKey);
  const target = client(dest.endpoint, dest.accessKeyId, dest.secretAccessKey);
  const db = record ? createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } }) : null;
  const sourcePrefix = options.sourcePrefix ?? "";
  const targetKey = (key: string) => `${options.targetPrefix}${key.slice(sourcePrefix.length)}`;

  async function* listSource(): AsyncGenerator<Item> {
    let token: string | undefined;
    do {
      const out = await source.send(new ListObjectsV2Command({ Bucket: options.source.bucket, Prefix: sourcePrefix || undefined, ContinuationToken: token, MaxKeys: 1000 }));
      for (const o of out.Contents ?? []) if (o.Key) yield { key: o.Key, size: Number(o.Size ?? 0), etag: (o.ETag ?? "").replace(/"/g, "") };
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  async function alreadyCopied(item: Item): Promise<boolean> {
    try {
      const head = await target.send(new HeadObjectCommand({ Bucket: backupBucket, Key: targetKey(item.key) }));
      return Number(head.ContentLength ?? -1) === item.size && head.Metadata?.["src-etag"] === item.etag;
    } catch {
      return false;
    }
  }

  async function copy(item: Item): Promise<void> {
    const Metadata = { "src-etag": item.etag };
    const Key = targetKey(item.key);
    if (item.size <= SINGLE_PUT_MAX) {
      const got = await source.send(new GetObjectCommand({ Bucket: options.source.bucket, Key: item.key }));
      if (!got.Body) throw new Error("sin cuerpo");
      await target.send(new PutObjectCommand({ Bucket: backupBucket, Key, Body: got.Body as never, ContentLength: item.size, Metadata }));
      return;
    }
    // Objetos muy grandes: multipart manual por tramos con Range (memoria acotada a una parte)
    const created = await target.send(new CreateMultipartUploadCommand({ Bucket: backupBucket, Key, Metadata }));
    const uploadId = created.UploadId;
    if (!uploadId) throw new Error("sin uploadId");
    try {
      const parts: { PartNumber: number; ETag: string }[] = [];
      for (let start = 0, n = 1; start < item.size; start += PART_SIZE, n++) {
        const end = Math.min(item.size, start + PART_SIZE) - 1;
        const got = await source.send(new GetObjectCommand({ Bucket: options.source.bucket, Key: item.key, Range: `bytes=${start}-${end}` }));
        const body = Buffer.from(await (got.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
        const up = await target.send(new UploadPartCommand({ Bucket: backupBucket, Key, UploadId: uploadId, PartNumber: n, Body: body }));
        parts.push({ PartNumber: n, ETag: up.ETag ?? "" });
      }
      await target.send(new CompleteMultipartUploadCommand({ Bucket: backupBucket, Key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
    } catch (error) {
      await target.send(new AbortMultipartUploadCommand({ Bucket: backupBucket, Key, UploadId: uploadId })).catch(() => undefined);
      throw error;
    }
  }

  let seen = 0;
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  let bytes = 0;
  for await (const item of listSource()) {
    seen++;
    if (await alreadyCopied(item)) {
      skipped++;
      continue;
    }
    if (options.dryRun) {
      console.log(`  - copiaría ${item.size} bytes`);
      copied++;
      bytes += item.size;
      continue;
    }
    try {
      await copy(item);
      copied++;
      bytes += item.size;
    } catch (error) {
      failed++;
      console.warn(`  ! no se pudo copiar un objeto (${(error as Error).name}); se reintentará en la próxima ejecución.`); // sin claves en el log
    }
  }

  console.log(`${options.dryRun ? "[simulacro] " : ""}${options.label}: ${seen} objetos · ${copied} ${options.dryRun ? "por copiar" : "copiados"} (${bytes} bytes) · ${skipped} ya estaban · ${failed} con error.`);
  if (!options.dryRun && db) {
    // Constancia del resultado (solo cifras: nunca nombres ni claves de objeto)
    const detail = { seen, copied, skipped, failed, bytes };
    await db.from("activity_log").insert({ actor_id: null, action: `backup.${options.kind}`, resource_type: options.kind === "vault" ? "vault" : null, resource_id: null, metadata: detail });
    await db.from("backup_runs").insert({ kind: options.kind, status: failed === 0 ? "ok" : copied > 0 ? "partial" : "failed", detail });
  }
  process.exit(failed > 0 ? 2 : 0);
}
