/**
 * Restaura los archivos desde el bucket de copia a un bucket NUEVO (entorno limpio o recuperación tras una pérdida).
 * Copia `main/` del bucket de copia a la raíz del bucket de destino, solo lo que falte (se puede repetir y reanudar).
 *
 *   npm run restore-files -- --dry-run
 *   npm run restore-files
 *
 * Variables: R2_BACKUP_BUCKET + R2_BACKUP_ENDPOINT + R2_BACKUP_ACCESS_KEY_ID/SECRET (origen, lectura) y
 * RESTORE_BUCKET + RESTORE_ENDPOINT + RESTORE_ACCESS_KEY_ID/SECRET (destino, escritura). Para el Vault: añade `--vault`
 * (copia la raíz del bucket de copia del Vault, que se guardó sin prefijo, a RESTORE_BUCKET). No anota nada en la base de
 * datos (puede no existir todavía). Guía completa y tiempos: docs/BACKUPS.md.
 */
import { env, runBucketBackup, stop } from "./lib/bucket-backup.ts";

for (const name of ["R2_BACKUP_BUCKET", "R2_BACKUP_ACCESS_KEY_ID", "R2_BACKUP_SECRET_ACCESS_KEY", "RESTORE_BUCKET", "RESTORE_ENDPOINT", "RESTORE_ACCESS_KEY_ID", "RESTORE_SECRET_ACCESS_KEY"]) {
  if (!env(name)) stop(`Falta ${name}.`);
}
const vault = process.argv.includes("--vault");

await runBucketBackup({
  label: vault ? "Restauración del Vault" : "Restauración de archivos",
  kind: vault ? "vault" : "files",
  record: false,
  sourcePrefix: vault ? "vault/" : "main/",
  targetPrefix: vault ? "vault/" : "",
  source: {
    bucket: env("R2_BACKUP_BUCKET"),
    endpoint: env("R2_BACKUP_ENDPOINT") || env("R2_ENDPOINT") || `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    accessKeyId: env("R2_BACKUP_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_BACKUP_SECRET_ACCESS_KEY"),
  },
  target: { bucket: env("RESTORE_BUCKET"), endpoint: env("RESTORE_ENDPOINT"), accessKeyId: env("RESTORE_ACCESS_KEY_ID"), secretAccessKey: env("RESTORE_SECRET_ACCESS_KEY") },
  dryRun: process.argv.includes("--dry-run"),
});
