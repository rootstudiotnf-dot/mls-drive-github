import "server-only";

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getMailConfig, getR2Config, getTranscoderConfig, isVaultConfigured } from "@/lib/env";
import { getS3 } from "@/lib/storage/client";
import { vaultBackend } from "@/lib/storage/vault-client";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Estado de los servicios para `/admin/estado` (solo owner) y para las alertas por correo. Todo son comprobaciones
 * de solo lectura. Nada de lo que se devuelve contiene claves, URLs, nombres de objeto ni datos de personas.
 */
export type CheckStatus = "ok" | "warn" | "fail" | "off";
export type Check = { key: string; label: string; status: CheckStatus; detail: string };
export type RecentError = { id: string; scope: string; name: string; code: string | null; createdAt: string };
export type Health = { generatedAt: string; checks: Check[]; errors24h: number; recentErrors: RecentError[] };

const HOUR = 3_600_000;
/** Cuánto sin copia antes de avisar: la frecuencia recomendada es diaria. */
export const BACKUP_STALE_HOURS = 36;
export const STORAGE_WARN_RATIO = 0.8;
export const STORAGE_FAIL_RATIO = 0.95;
const STUCK_JOB_MINUTES = 30;

async function timed<T>(work: () => Promise<T>, timeoutMs = 6000): Promise<{ ok: true; value: T; ms: number } | { ok: false; ms: number }> {
  const t0 = Date.now();
  try {
    const value = await Promise.race([work(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))]);
    return { ok: true, value, ms: Date.now() - t0 };
  } catch {
    return { ok: false, ms: Date.now() - t0 };
  }
}

const since = (iso: string) => {
  const hours = (Date.now() - Date.parse(iso)) / HOUR;
  return hours < 1 ? "hace menos de 1 h" : hours < 48 ? `hace ${Math.round(hours)} h` : `hace ${Math.round(hours / 24)} días`;
};

export function storageQuotaBytes(): number | null {
  const gb = Number(process.env.STORAGE_QUOTA_GB);
  return Number.isFinite(gb) && gb > 0 ? gb * 1024 ** 3 : null;
}

export async function collectHealth(): Promise<Health> {
  const admin = createAdminClient();
  const checks: Check[] = [];

  // Base de datos
  const db = await timed(async () => (await admin.from("profiles").select("id", { count: "exact", head: true })).error === null);
  checks.push({ key: "database", label: "Base de datos", status: db.ok && db.value ? "ok" : "fail", detail: db.ok && db.value ? `Responde (${db.ms} ms)` : "No responde" });

  // R2: bucket principal y Vault (solo se comprueba que se puede listar 1 objeto; no se leen nombres)
  let mainReady = true;
  try {
    getR2Config();
  } catch {
    mainReady = false;
  }
  if (!mainReady) checks.push({ key: "r2", label: "Almacenamiento (R2)", status: "fail", detail: "Sin configurar" });
  else {
    const r2 = await timed(() => getS3().send(new ListObjectsV2Command({ Bucket: getR2Config().bucket, MaxKeys: 1 })));
    checks.push({ key: "r2", label: "Almacenamiento (R2)", status: r2.ok ? "ok" : "fail", detail: r2.ok ? `Bucket principal accesible (${r2.ms} ms)` : "El bucket principal no responde" });
  }
  if (!isVaultConfigured()) checks.push({ key: "r2-vault", label: "Bucket del Vault", status: "off", detail: "No configurado (el Vault está cerrado)" });
  else {
    const vault = await timed(() => {
      const { s3, bucket } = vaultBackend();
      return s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    });
    checks.push({ key: "r2-vault", label: "Bucket del Vault", status: vault.ok ? "ok" : "fail", detail: vault.ok ? `Accesible (${vault.ms} ms)` : "El bucket del Vault no responde" });
  }

  // Espacio usado frente a la cuota (STORAGE_QUOTA_GB)
  const usage = await admin.rpc("storage_usage");
  const used = ((usage.data ?? []) as { bytes: number | string }[]).reduce((sum, r) => sum + Number(r.bytes ?? 0), 0);
  const quota = storageQuotaBytes();
  if (!quota) checks.push({ key: "storage", label: "Espacio usado", status: "off", detail: `${(used / 1024 ** 3).toFixed(1)} GB usados (define STORAGE_QUOTA_GB para recibir el aviso del 80 %)` });
  else {
    const ratio = used / quota;
    checks.push({ key: "storage", label: "Espacio usado", status: ratio >= STORAGE_FAIL_RATIO ? "fail" : ratio >= STORAGE_WARN_RATIO ? "warn" : "ok", detail: `${(used / 1024 ** 3).toFixed(1)} de ${(quota / 1024 ** 3).toFixed(0)} GB (${Math.round(ratio * 100)} %)` });
  }

  // Transcodificador y cola de procesado
  const transcoder = getTranscoderConfig();
  const { data: jobRows } = await admin.from("media_jobs").select("status, requested_at, started_at").in("status", ["queued", "processing"]).limit(2000);
  const jobs = (jobRows ?? []) as { status: string; requested_at: string; started_at: string | null }[];
  const stuck = jobs.filter((j) => Date.now() - Date.parse(j.started_at ?? j.requested_at) > STUCK_JOB_MINUTES * 60_000).length;
  if (!transcoder) checks.push({ key: "transcoder", label: "Transcodificador", status: "off", detail: "No configurado (los vídeos quedan en cola)" });
  else {
    const ping = await timed(async () => (await fetch(`${transcoder.url}/health`, { signal: AbortSignal.timeout(5000), cache: "no-store" })).ok);
    checks.push({ key: "transcoder", label: "Transcodificador", status: ping.ok && ping.value ? "ok" : "fail", detail: ping.ok && ping.value ? `Responde (${ping.ms} ms)` : "No responde" });
  }
  checks.push({ key: "queue", label: "Cola de procesado", status: stuck > 0 ? "warn" : "ok", detail: `${jobs.length} en curso o en cola${stuck > 0 ? ` · ${stuck} atascados más de ${STUCK_JOB_MINUTES} min` : ""}` });

  // Copias de seguridad
  const { data: runRows } = await admin.from("backup_runs").select("kind, status, created_at").order("created_at", { ascending: false }).limit(60);
  const runs = (runRows ?? []) as { kind: "db" | "files" | "vault"; status: "ok" | "partial" | "failed"; created_at: string }[];
  for (const [kind, label] of [["db", "Copia de la base de datos"], ["files", "Copia de los archivos"], ["vault", "Copia del Vault"]] as const) {
    if (kind === "vault" && !isVaultConfigured()) continue;
    const last = runs.find((r) => r.kind === kind);
    if (!last) checks.push({ key: `backup-${kind}`, label, status: "warn", detail: "Todavía no se ha hecho ninguna" });
    else {
      const stale = Date.now() - Date.parse(last.created_at) > BACKUP_STALE_HOURS * HOUR;
      const status: CheckStatus = last.status === "failed" ? "fail" : last.status === "partial" || stale ? "warn" : "ok";
      checks.push({ key: `backup-${kind}`, label, status, detail: `${last.status === "ok" ? "Correcta" : last.status === "partial" ? "Parcial" : "Fallida"} · ${since(last.created_at)}${stale ? " · demasiado antigua" : ""}` });
    }
  }

  // Correo
  checks.push({ key: "mail", label: "Correo (Resend)", status: getMailConfig() ? "ok" : "off", detail: getMailConfig() ? "Configurado" : "Sin configurar: no se envían correos ni alertas" });

  // Errores recientes
  const [{ data: errRows }, errCount] = await Promise.all([
    admin.from("error_log").select("id, scope, name, code, created_at").order("created_at", { ascending: false }).limit(20),
    admin.from("error_log").select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 24 * HOUR).toISOString()),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    checks,
    errors24h: errCount.count ?? 0,
    recentErrors: ((errRows ?? []) as { id: string; scope: string; name: string; code: string | null; created_at: string }[]).map((r) => ({ id: r.id, scope: r.scope, name: r.name, code: r.code, createdAt: r.created_at })),
  };
}
