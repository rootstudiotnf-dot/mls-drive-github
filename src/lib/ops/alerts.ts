import "server-only";

import { getMailConfig, getSiteUrl } from "@/lib/env";
import { sendMail } from "@/lib/notifications/mail";
import { createAdminClient } from "@/lib/supabase/admin";
import { collectHealth, type Check } from "./health";

/**
 * Avisos por correo al owner: copia fallida o atrasada, almacenamiento por encima del 80 %, servicios caídos o
 * cola atascada. Un mismo aviso no se repite antes de 24 h (tabla `ops_alerts`); si el problema se arregla, la
 * siguiente vez que aparezca se vuelve a avisar. El correo no lleva datos de personas ni de archivos.
 */
const REPEAT_HOURS = 24;
const ALERTABLE = new Set(["database", "r2", "r2-vault", "storage", "transcoder", "queue", "backup-db", "backup-files", "backup-vault"]);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export function problemsOf(checks: Check[]): Check[] {
  return checks.filter((c) => ALERTABLE.has(c.key) && (c.status === "fail" || c.status === "warn"));
}

export async function ownerEmails(): Promise<string[]> {
  const admin = createAdminClient();
  const { data: role } = await admin.from("roles").select("id").eq("key", "owner").maybeSingle();
  if (!role) return [];
  const { data } = await admin.from("profiles").select("email").eq("role_id", (role as { id: string }).id).eq("status", "active");
  return ((data ?? []) as { email: string }[]).map((p) => p.email).filter(Boolean);
}

async function deliver(to: string[], subject: string, lines: string[]): Promise<boolean> {
  const config = getMailConfig();
  if (!config || to.length === 0) return false;
  const url = `${getSiteUrl()}/admin/estado`;
  const text = `${lines.join("\n")}\n\nEstado de los servicios: ${url}`;
  const html = `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5">${lines.map(esc).join("<br>")}</p><p style="font-family:Arial,sans-serif"><a href="${esc(url)}">Abrir el estado de los servicios</a></p>`;
  let any = false;
  for (const address of to) {
    const result = await sendMail(config, { to: address, subject, text, html });
    if (result.ok) any = true;
  }
  return any;
}

/** Evalúa y avisa. Devuelve cuántos problemas hay y cuántos avisos nuevos se enviaron. */
export async function runOpsAlerts(): Promise<{ problems: number; sent: number; mailConfigured: boolean }> {
  const admin = createAdminClient();
  const health = await collectHealth();
  const problems = problemsOf(health.checks);
  const { data: previous } = await admin.from("ops_alerts").select("key, last_sent_at");
  const last = new Map(((previous ?? []) as { key: string; last_sent_at: string }[]).map((r) => [r.key, Date.parse(r.last_sent_at)]));

  // Lo que ya está arreglado se olvida: si vuelve a fallar, se avisa de nuevo
  const activeKeys = new Set(problems.map((p) => p.key));
  const recovered = [...last.keys()].filter((k) => !activeKeys.has(k));
  if (recovered.length) await admin.from("ops_alerts").delete().in("key", recovered);

  const fresh = problems.filter((p) => !last.has(p.key) || Date.now() - (last.get(p.key) ?? 0) > REPEAT_HOURS * 3_600_000);
  let sent = 0;
  if (fresh.length > 0 && (await deliver(await ownerEmails(), `MLS Drive: ${fresh.length === 1 ? "hay un problema" : `hay ${fresh.length} problemas`} que revisar`, fresh.map((p) => `• ${p.label}: ${p.detail}`)))) {
    sent = fresh.length;
    await admin.from("ops_alerts").upsert(fresh.map((p) => ({ key: p.key, last_sent_at: new Date().toISOString(), last_state: p.status })), { onConflict: "key" });
  }
  return { problems: problems.length, sent, mailConfigured: getMailConfig() !== null };
}

/** Prueba forzada (botón del owner): comprueba que el correo de alertas llega. */
export async function sendTestAlert(): Promise<boolean> {
  return deliver(await ownerEmails(), "MLS Drive: prueba de aviso", ["Esto es una prueba: si lo lees, los avisos por correo funcionan."]);
}
