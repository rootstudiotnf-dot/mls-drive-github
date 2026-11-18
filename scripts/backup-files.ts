/**
 * Copia de seguridad del bucket PRINCIPAL (originales y derivados) a un bucket de copia, idealmente en otra cuenta o
 * proveedor. Incremental: solo copia lo nuevo o modificado. Deja constancia en `activity_log` y `backup_runs`.
 *
 *   npm run backup-files -- --dry-run
 *   npm run backup-files
 *
 * Variables (.env.local, solo servidor): R2_BUCKET + R2_ACCESS_KEY_ID/SECRET (origen, solo lectura basta) y
 * R2_BACKUP_BUCKET + R2_BACKUP_ENDPOINT + R2_BACKUP_ACCESS_KEY_ID/SECRET (destino, escritura). Los objetos se copian
 * bajo el prefijo `main/` del bucket de copia. Si falta R2_BACKUP_BUCKET lo indica y termina SIN error.
 * Recuperación: ver docs/BACKUPS.md.
 */
import { env, runBucketBackup, stop } from "./lib/bucket-backup.ts";

if (!env("R2_BACKUP_BUCKET")) {
  console.log("R2_BACKUP_BUCKET no está configurado: no hay copia de seguridad de los archivos. No se hace nada (ver docs/BACKUPS.md).");
  process.exit(0);
}
for (const name of ["R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
  if (!env(name)) stop(`Falta ${name} en .env.local.`);
}

await runBucketBackup({
  label: "Archivos",
  kind: "files",
  targetPrefix: "main/",
  source: {
    bucket: env("R2_BUCKET"),
    endpoint: env("R2_ENDPOINT") || `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  },
  dryRun: process.argv.includes("--dry-run"),
});
