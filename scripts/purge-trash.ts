/**
 * Borrado DEFINITIVO de lo que ya no debe existir:
 *   - assets en la papelera (deleted_at) con más de 30 días
 *   - subidas abandonadas (status 'uploading') con más de 48 horas
 *   - Vault (Fase 8): lo mismo, con el bucket y el token PROPIOS del Vault (R2_VAULT_*); además limpia los objetos
 *     huérfanos que dejan los movimientos entre buckets (tabla storage_orphans) y los movimientos abandonados
 * Para cada uno borra los objetos de R2 (original y derivados; aborta el multipart pendiente) y
 * las filas de la base de datos (asset, derivados, etiquetas y accesos de ese asset).
 *
 *   npm run purge-trash -- --dry-run     (solo muestra qué se borraría)
 *   npm run purge-trash -- --yes         (borra de verdad)
 *
 * Pensado para ejecutarse a mano o desde una tarea programada (cron). Usa el service role y las
 * credenciales de R2 de .env.local: ejecútalo solo donde confíes. Es seguro repetirlo.
 * Requiere Node 22.18+ (ejecuta TypeScript directamente); solo usa sintaxis borrable.
 */
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

const TRASH_DAYS = 30;
const STALE_UPLOAD_HOURS = 48;
const BATCH = 200;

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}
function need(name: string): string {
  const value = process.env[name];
  if (!value) stop(`Falta ${name} en .env.local.`);
  return value;
}

const dryRun = process.argv.includes("--dry-run");
if (!dryRun && !process.argv.includes("--yes")) {
  stop("Esto BORRA archivos de forma definitiva. Usa --dry-run para ver qué se borraría o --yes para confirmar.");
}

const accountId = need("R2_ACCOUNT_ID");
const bucket = need("R2_BUCKET");
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: { accessKeyId: need("R2_ACCESS_KEY_ID"), secretAccessKey: need("R2_SECRET_ACCESS_KEY") },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});
// Cliente del bucket del Vault (solo si está configurado): su token no toca el bucket normal ni al revés
const vaultBucket = process.env.R2_VAULT_BUCKET;
const vaultS3 =
  vaultBucket && process.env.R2_VAULT_ACCESS_KEY_ID && process.env.R2_VAULT_SECRET_ACCESS_KEY
    ? new S3Client({
        region: "auto",
        endpoint: process.env.R2_VAULT_ENDPOINT?.trim() || process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
        forcePathStyle: true,
        credentials: { accessKeyId: process.env.R2_VAULT_ACCESS_KEY_ID, secretAccessKey: process.env.R2_VAULT_SECRET_ACCESS_KEY },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      })
    : null;
const db = createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Candidate = {
  id: string;
  space: "workspace" | "vault";
  storage_key: string;
  upload_id: string | null;
  status: string;
  deleted_at: string | null;
  created_at: string;
};

const now = Date.now();
const trashCutoff = new Date(now - TRASH_DAYS * 24 * 3600 * 1000).toISOString();
const staleCutoff = new Date(now - STALE_UPLOAD_HOURS * 3600 * 1000).toISOString();

const COLUMNS = "id, space, storage_key, upload_id, status, deleted_at, created_at";

const trashed = await db.from("assets").select(COLUMNS).lt("deleted_at", trashCutoff).limit(BATCH);
if (trashed.error) stop(`Error leyendo la papelera: ${trashed.error.message}`);
const stale = await db
  .from("assets")
  .select(COLUMNS)
  .eq("status", "uploading")
  .lt("created_at", staleCutoff)
  .limit(BATCH);
if (stale.error) stop(`Error leyendo subidas abandonadas: ${stale.error.message}`);

const byId = new Map<string, Candidate>();
for (const row of [...(trashed.data as Candidate[]), ...(stale.data as Candidate[])]) byId.set(row.id, row);
const candidates = [...byId.values()];

console.log(
  `${dryRun ? "[simulacro] " : ""}${trashed.data.length} en la papelera (>${TRASH_DAYS} días) · ` +
    `${stale.data.length} subidas abandonadas (>${STALE_UPLOAD_HOURS} h) · ${candidates.length} en total`,
);

async function removeObject(key: string, inVault = false) {
  try {
    const client = inVault ? vaultS3 : s3;
    if (!client) throw new Error("sin cliente del Vault");
    await client.send(new DeleteObjectCommand({ Bucket: inVault ? (vaultBucket as string) : bucket, Key: key }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404) throw error; // un objeto que ya no existe no es un error
  }
}

let purged = 0;
let skipped = 0;
for (const asset of candidates) {
  const inVault = asset.space === "vault";
  if (inVault && !vaultS3) {
    console.warn(`  ! ${asset.id}: es del Vault y no hay R2_VAULT_* configurado; se omite (no se toca nada).`);
    skipped++;
    continue;
  }
  const { data: derivatives } = await db.from("asset_derivatives").select("storage_key").eq("asset_id", asset.id);
  const keys = [asset.storage_key, ...((derivatives ?? []) as { storage_key: string }[]).map((d) => d.storage_key)];
  const reason = asset.status === "uploading" ? "subida abandonada" : "papelera";

  if (dryRun) {
    console.log(`  - ${asset.id} (${reason}, ${keys.length} objeto${keys.length === 1 ? "" : "s"})`);
    continue;
  }

  // 1) Primero las filas que lo referencian: si un beat usa este asset se salta (nada a medias)
  const { error: assetError } = await db.from("assets").delete().eq("id", asset.id);
  if (assetError) {
    console.warn(`  ! ${asset.id}: no se pudo borrar la fila (${assetError.code ?? assetError.message}); se omite.`);
    skipped++;
    continue;
  }
  await db.from("taggings").delete().eq("resource_type", "asset").eq("resource_id", asset.id);
  await db.from("grants").delete().eq("resource_type", "asset").eq("resource_id", asset.id);

  // 2) Después los objetos de R2 (si falla alguno, la fila ya no existe: se verá en el aviso)
  try {
    if (asset.upload_id) {
      await (inVault ? vaultS3 : s3)!
        .send(new AbortMultipartUploadCommand({ Bucket: inVault ? (vaultBucket as string) : bucket, Key: asset.storage_key, UploadId: asset.upload_id }))
        .catch(() => undefined);
    }
    for (const key of keys) await removeObject(key, inVault);
  } catch (error) {
    console.warn(`  ! ${asset.id}: fila borrada pero falló el borrado en R2 (${(error as Error).name}). Revisa el bucket.`);
  }

  await db.from("activity_log").insert({
    actor_id: null,
    action: inVault ? "vault.delete" : "asset.purged",
    resource_type: "asset",
    resource_id: asset.id,
    metadata: { reason, ...(inVault ? { auto: true } : {}) },
  });
  purged++;
}

// Objetos que dejó un movimiento entre buckets (el origen no se pudo borrar o la copia se descartó)
const orphans = await db.from("storage_orphans").select("id, bucket, object_key").order("created_at").limit(BATCH);
let orphansDone = 0;
for (const orphan of (orphans.data ?? []) as { id: string; bucket: "main" | "vault"; object_key: string }[]) {
  if (dryRun) {
    console.log(`  - huérfano en ${orphan.bucket}`);
    continue;
  }
  try {
    await removeObject(orphan.object_key, orphan.bucket === "vault");
    await db.from("storage_orphans").delete().eq("id", orphan.id);
    orphansDone++;
  } catch {
    console.warn(`  ! huérfano ${orphan.id}: no se pudo borrar todavía; se reintentará.`);
  }
}
// Movimientos entre buckets abandonados (>1 h): se aborta el multipart y se descarta lo copiado
const movesCutoff = new Date(now - 3600 * 1000).toISOString();
const moves = await db.from("vault_moves").select("asset_id, direction, dest_key, upload_id").lt("created_at", movesCutoff).limit(BATCH);
let movesDone = 0;
for (const move of (moves.data ?? []) as { asset_id: string; direction: "in" | "out"; dest_key: string; upload_id: string | null }[]) {
  if (dryRun) {
    console.log(`  - movimiento abandonado ${move.asset_id}`);
    continue;
  }
  const toVault = move.direction === "in";
  const client = toVault ? vaultS3 : s3;
  if (!client) continue;
  const targetBucket = toVault ? (vaultBucket as string) : bucket;
  try {
    if (move.upload_id) await client.send(new AbortMultipartUploadCommand({ Bucket: targetBucket, Key: move.dest_key, UploadId: move.upload_id })).catch(() => undefined);
    await removeObject(move.dest_key, toVault);
    await db.from("vault_moves").delete().eq("asset_id", move.asset_id);
    movesDone++;
  } catch {
    console.warn(`  ! movimiento ${move.asset_id}: no se pudo limpiar todavía.`);
  }
}

if (!dryRun) console.log(`Hecho: ${purged} eliminados definitivamente, ${skipped} omitidos, ${orphansDone} huérfanos y ${movesDone} movimientos abandonados limpiados.`);
if (candidates.length >= BATCH) console.log(`(Había más de ${BATCH}: vuelve a ejecutarlo para seguir.)`);
