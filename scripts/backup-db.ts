/**
 * Volcado propio de la base de datos (además de los backups automáticos de Supabase).
 * Ejecuta `pg_dump` (formato personalizado, comprimido) de los esquemas `public` y `auth`, lo sube al bucket de copia
 * bajo `db/mls-db-AAAA-MM-DD.dump`, borra los de más de 30 días y deja constancia en `backup_runs` y `activity_log`.
 *
 *   npm run backup-db -- --dry-run     (solo comprueba la configuración y que pg_dump existe)
 *   npm run backup-db
 *
 * Variables (.env.local o secretos del programador): SUPABASE_DB_URL (cadena de conexión de Postgres: en Supabase,
 * Project Settings → Database → Connection string; usa la directa o la de sesión, no la de transacción), R2_BACKUP_*
 * y las de Supabase. Requiere `pg_dump` de la MISMA versión mayor que la base de datos (o superior).
 * El volcado contiene datos de personas: el bucket de copia debe ser privado y estar en otra cuenta o proveedor.
 * Frecuencia recomendada: diaria (ver .github/workflows/backups.yml). Retención: 30 días (BACKUP_RETENTION_DAYS).
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

const env = (name: string) => process.env[name]?.trim() || "";
const dryRun = process.argv.includes("--dry-run");
const RETENTION_DAYS = Math.max(1, Number(env("BACKUP_RETENTION_DAYS")) || 30);

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}
for (const name of ["SUPABASE_DB_URL", "R2_BACKUP_BUCKET", "R2_BACKUP_ACCESS_KEY_ID", "R2_BACKUP_SECRET_ACCESS_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!env(name)) stop(`Falta ${name}.`);
}

const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
const s3 = new S3Client({
  region: "auto",
  endpoint: env("R2_BACKUP_ENDPOINT") || `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: { accessKeyId: env("R2_BACKUP_ACCESS_KEY_ID"), secretAccessKey: env("R2_BACKUP_SECRET_ACCESS_KEY") },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});
const bucket = env("R2_BACKUP_BUCKET");

function run(command: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    // La cadena de conexión viaja por entorno (PGDATABASE no admite URI completa en todos los clientes; pg_dump sí la acepta como argumento
    // `--dbname`, pero así no aparece en la lista de procesos).
    const child = spawn(command, args, { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => (err = (err + chunk.toString()).slice(-400)));
    child.on("error", () => resolve({ code: 127, err: "no se pudo ejecutar el comando (¿está instalado?)" }));
    child.on("close", (code) => resolve({ code: code ?? 1, err }));
  });
}

async function record(status: "ok" | "failed", detail: Record<string, unknown>) {
  await db.from("backup_runs").insert({ kind: "db", status, detail });
  await db.from("activity_log").insert({ actor_id: null, action: "backup.db", resource_type: null, resource_id: null, metadata: { status, ...detail } });
}

if (dryRun) {
  const probe = await run("pg_dump", ["--version"]);
  console.log(probe.code === 0 ? "[simulacro] pg_dump disponible y configuración completa." : `[simulacro] pg_dump no disponible: ${probe.err}`);
  process.exit(probe.code === 0 ? 0 : 1);
}

const stamp = new Date().toISOString().slice(0, 10);
const dir = await mkdtemp(join(tmpdir(), "mls-db-"));
const file = join(dir, `mls-db-${stamp}.dump`);
try {
  const dump = await run("pg_dump", ["--format=custom", "--compress=9", "--no-owner", "--no-privileges", "--schema=public", "--schema=auth", "--file", file, "--dbname", env("SUPABASE_DB_URL")]);
  if (dump.code !== 0) {
    await record("failed", { step: "pg_dump", code: dump.code });
    stop(`pg_dump falló (código ${dump.code}).`);
  }
  const { size } = await stat(file);
  if (size < 1024) {
    await record("failed", { step: "tamaño", bytes: size });
    stop("El volcado está vacío o es sospechosamente pequeño.");
  }
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `db/mls-db-${stamp}.dump`, Body: createReadStream(file), ContentLength: size, ContentType: "application/octet-stream" }));

  // Retención: se borran los volcados de más de RETENTION_DAYS
  const limit = Date.now() - RETENTION_DAYS * 86_400_000;
  let deleted = 0;
  let token: string | undefined;
  do {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "db/", ContinuationToken: token }));
    for (const o of out.Contents ?? []) {
      if (o.Key && o.LastModified && o.LastModified.getTime() < limit) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }));
        deleted++;
      }
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);

  await record("ok", { bytes: size, deleted });
  console.log(`Volcado subido (${size} bytes). Antiguos borrados: ${deleted}.`);
} catch (error) {
  await record("failed", { step: "subida", error: (error as Error).name }).catch(() => undefined);
  stop(`Falló la copia de la base de datos (${(error as Error).name}).`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
