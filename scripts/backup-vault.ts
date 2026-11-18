/**
 * Copia de seguridad del Vault: copia los objetos NUEVOS o MODIFICADOS del bucket del Vault a un bucket de copia
 * (idealmente en OTRA cuenta o proveedor) y deja constancia del resultado (`activity_log` y `backup_runs`).
 *
 *   npm run backup-vault -- --dry-run     (solo muestra qué copiaría)
 *   npm run backup-vault                  (copia de verdad)
 *
 * Variables (en .env.local, solo servidor): R2_VAULT_BUCKET + R2_VAULT_ACCESS_KEY_ID/SECRET (origen, de lectura) y
 * R2_BACKUP_BUCKET + R2_BACKUP_ENDPOINT + R2_BACKUP_ACCESS_KEY_ID/SECRET (destino, de escritura). Si falta
 * R2_BACKUP_BUCKET lo indica y termina SIN error (la copia es opcional). Es seguro repetirlo.
 * La lógica común está en scripts/lib/bucket-backup.ts (la comparte con backup-files).
 */
import { env, runBucketBackup, stop } from "./lib/bucket-backup.ts";

if (!env("R2_BACKUP_BUCKET")) {
  console.log("R2_BACKUP_BUCKET no está configurado: no hay copia de seguridad del Vault. No se hace nada (ver docs/SETUP-VAULT.md).");
  process.exit(0);
}
for (const name of ["R2_VAULT_BUCKET", "R2_VAULT_ACCESS_KEY_ID", "R2_VAULT_SECRET_ACCESS_KEY"]) {
  if (!env(name)) stop(`Falta ${name} en .env.local.`);
}
const accountId = env("R2_ACCOUNT_ID");

await runBucketBackup({
  label: "Vault",
  kind: "vault",
  targetPrefix: "",
  source: {
    bucket: env("R2_VAULT_BUCKET"),
    endpoint: env("R2_VAULT_ENDPOINT") || env("R2_ENDPOINT") || `https://${accountId}.r2.cloudflarestorage.com`,
    accessKeyId: env("R2_VAULT_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_VAULT_SECRET_ACCESS_KEY"),
  },
  dryRun: process.argv.includes("--dry-run"),
});
