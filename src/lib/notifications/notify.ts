import "server-only";

import { after } from "next/server";
import { getMailConfig, getShareSalt, getSiteUrl } from "@/lib/env";
import { can } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULTS, mergePayloads, safePayload, type NotificationEvent, type NotificationPayload, type Preference } from "./events";
import { sendMail } from "./mail";
import { renderDigest, renderInstant, signUnsubscribe, type MailItem } from "./templates";

/**
 * `notify(event, input)`: la ÚNICA puerta de entrada de avisos. Nunca lanza y nunca bloquea la acción del usuario.
 *
 *  - Bandeja interna: un aviso por persona; si ya hay uno SIN LEER del mismo grupo en los últimos 10 minutos se
 *    suma (12 fotos publicadas = un aviso «12 archivos nuevos…», no doce).
 *  - Correo: se encola (`notification_outbox`) y se envía como máximo UNO instantáneo por recurso cada 10 minutos
 *    (lo que llega en medio se funde en el siguiente) o dentro del resumen diario, según la preferencia.
 *  - Nada del Vault: si algún archivo implicado es del Vault, el aviso se descarta entero. Los destinatarios los
 *    decide quien llama FILTRANDO por acceso (ver `withAccess`): un aviso nunca revela un recurso a quien no lo ve.
 *  - Los correos llevan solo texto y un enlace a la plataforma: ni archivos ni URLs firmadas.
 */

const INSTANT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export type NotifyInput = {
  recipients: string[];
  actorId?: string | null;
  /** Agrupa avisos del mismo recurso (p. ej. `upload:<artista>:<sesión>`) */
  groupKey: string;
  payload: NotificationPayload;
  /** Archivos implicados: si alguno es del Vault, no se avisa de nada */
  assetIds?: string[];
};

/** Personas (de la lista) que pueden VER el recurso: así un aviso nunca descubre algo a quien no tiene acceso. */
export async function withAccess(userIds: string[], resource: { type: "artist" | "session" | "asset" | "beat" | "folder"; id: string }): Promise<string[]> {
  const unique = [...new Set(userIds)];
  const checks = await Promise.all(unique.map(async (id) => ((await can(id, "view", resource)) ? id : null)));
  return checks.filter((id): id is string => id !== null);
}

async function loadPrefs(userIds: string[], event: NotificationEvent): Promise<Map<string, Preference>> {
  const out = new Map<string, Preference>();
  if (userIds.length === 0) return out;
  const { data } = await createAdminClient().from("notification_settings").select("user_id, channel, frequency").eq("event", event).in("user_id", userIds);
  for (const id of userIds) out.set(id, DEFAULTS[event]);
  for (const row of (data ?? []) as { user_id: string; channel: Preference["channel"]; frequency: Preference["frequency"] }[]) {
    out.set(row.user_id, { channel: row.channel, frequency: row.frequency });
  }
  return out;
}

export async function notify(event: NotificationEvent, input: NotifyInput): Promise<void> {
  try {
    const admin = createAdminClient();
    if (input.assetIds && input.assetIds.length > 0) {
      const { data } = await admin.from("assets").select("id").in("id", input.assetIds.slice(0, 1000)).eq("space", "vault").limit(1);
      if ((data?.length ?? 0) > 0) return; // nada del Vault, ni siquiera un aviso genérico
    }
    const payload = safePayload(input.payload);
    const wanted = [...new Set(input.recipients)].filter((id) => id && id !== input.actorId);
    if (wanted.length === 0) return;
    const { data: people } = await admin.from("profiles").select("id").in("id", wanted).eq("status", "active");
    const active = ((people ?? []) as { id: string }[]).map((p) => p.id);
    const prefs = await loadPrefs(active, event);
    const mail = getMailConfig() !== null && getShareSalt() !== null;
    const since = new Date(Date.now() - INSTANT_WINDOW_MS).toISOString();

    for (const userId of active) {
      const pref = prefs.get(userId) ?? DEFAULTS[event];
      if (pref.channel === "off") continue; // desactivado: ni correo ni bandeja

      // Bandeja interna (con fusión de avisos del mismo grupo sin leer)
      const { data: recent } = await admin.from("notifications").select("id, payload").eq("user_id", userId).eq("group_key", input.groupKey).is("read_at", null).gte("created_at", since).order("created_at", { ascending: false }).limit(1);
      const last = (recent ?? [])[0] as { id: string; payload: NotificationPayload } | undefined;
      if (last) {
        await admin.from("notifications").update({ payload: mergePayloads([last.payload, payload]), created_at: new Date().toISOString() }).eq("id", last.id);
      } else {
        await admin.from("notifications").insert({ user_id: userId, type: event, payload, group_key: input.groupKey });
      }

      if (mail) {
        await admin.from("notification_outbox").insert({ user_id: userId, event, frequency: pref.frequency, group_key: input.groupKey, payload });
      }
    }
    if (mail) {
      try {
        after(() => void flushOutbox());
      } catch {
        /* fuera de una petición (script, cron): el cron lo recoge */
      }
    }
  } catch (error) {
    console.error("notify failed:", error instanceof Error ? error.name : "unknown");
  }
}

// ---------------------------------------------------------------------------
// Cola de correo
// ---------------------------------------------------------------------------

type OutboxRow = { id: string; user_id: string; event: NotificationEvent; frequency: "instant" | "daily"; group_key: string; payload: NotificationPayload; attempts: number; created_at: string };
type Person = { id: string; email: string; full_name: string | null };

async function people(ids: string[]): Promise<Map<string, Person>> {
  const { data } = await createAdminClient().from("profiles").select("id, email, full_name").in("id", ids).eq("status", "active");
  return new Map(((data ?? []) as Person[]).map((p) => [p.id, p]));
}

async function finish(ids: string[], ok: boolean, attempts: number, error?: string): Promise<void> {
  const admin = createAdminClient();
  if (ok) await admin.from("notification_outbox").update({ status: "sent", sent_at: new Date().toISOString(), last_error: null }).in("id", ids);
  else await admin.from("notification_outbox").update({ attempts, last_error: (error ?? "error").slice(0, 200), status: attempts >= MAX_ATTEMPTS ? "failed" : "pending" }).in("id", ids);
}

/** ¿Reintento permitido ya? Retroceso: 5 min × nº de intentos fallidos. */
const retryDue = (row: OutboxRow, now: number) => row.attempts === 0 || now - Date.parse(row.created_at) >= row.attempts * 5 * 60_000;

/** Envía lo instantáneo pendiente: un correo por (persona, recurso) y como máximo uno cada 10 minutos. */
export async function flushOutbox(now = Date.now()): Promise<{ sent: number; deferred: number; failed: number }> {
  const stats = { sent: 0, deferred: 0, failed: 0 };
  const config = getMailConfig();
  const salt = getShareSalt();
  if (!config || !salt) return stats;
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("notification_outbox").select("id, user_id, event, frequency, group_key, payload, attempts, created_at").eq("status", "pending").eq("frequency", "instant").order("created_at").limit(500);
    const rows = (data ?? []) as OutboxRow[];
    const groups = new Map<string, OutboxRow[]>();
    for (const row of rows) groups.set(`${row.user_id}|${row.group_key}`, [...(groups.get(`${row.user_id}|${row.group_key}`) ?? []), row]);
    const directory = await people([...new Set(rows.map((r) => r.user_id))]);

    for (const list of groups.values()) {
      const first = list[0] as OutboxRow;
      if (!list.every((r) => retryDue(r, now))) continue;
      const person = directory.get(first.user_id);
      if (!person) {
        await finish(list.map((r) => r.id), true, 0); // persona desactivada: nada que enviar
        continue;
      }
      // La preferencia vigente manda (pudo cambiar tras encolar)
      const pref = (await loadPrefs([first.user_id], first.event)).get(first.user_id) ?? DEFAULTS[first.event];
      if (pref.channel === "off") {
        await admin.from("notification_outbox").update({ status: "skipped" }).in("id", list.map((r) => r.id));
        continue;
      }
      const { data: sentRecently } = await admin.from("notification_outbox").select("id").eq("user_id", first.user_id).eq("group_key", first.group_key).eq("status", "sent").gte("sent_at", new Date(now - INSTANT_WINDOW_MS).toISOString()).limit(1);
      if ((sentRecently?.length ?? 0) > 0) {
        stats.deferred++; // máx. un instantáneo por recurso cada 10 min: se funde en el siguiente
        continue;
      }
      const siteUrl = getSiteUrl();
      const unsubscribeUrl = `${siteUrl}/baja/${signUnsubscribe(first.user_id, first.event, salt)}`;
      const mail = renderInstant(list.map((r) => ({ event: r.event, payload: r.payload }) satisfies MailItem), { siteUrl, unsubscribeUrl });
      const result = await sendMail(config, { to: person.email, ...mail, unsubscribeUrl, oneClickUrl: `${siteUrl}/api/baja/${signUnsubscribe(first.user_id, first.event, salt)}` });
      if (result.ok) {
        await finish(list.map((r) => r.id), true, 0);
        stats.sent++;
      } else {
        await finish(list.map((r) => r.id), false, first.attempts + 1, result.error);
        stats.failed++;
      }
    }
  } catch (error) {
    console.error("flushOutbox failed:", error instanceof Error ? error.name : "unknown");
  }
  return stats;
}

const dateLabel = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", timeZone: "Atlantic/Canary" });

/** Resumen diario: un correo por persona con todo lo pendiente «daily», agrupado por artista. */
export async function sendDigests(now = Date.now()): Promise<{ sent: number; failed: number }> {
  const stats = { sent: 0, failed: 0 };
  const config = getMailConfig();
  const salt = getShareSalt();
  if (!config || !salt) return stats;
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("notification_outbox").select("id, user_id, event, frequency, group_key, payload, attempts, created_at").eq("status", "pending").eq("frequency", "daily").order("created_at").limit(2000);
    const rows = (data ?? []) as OutboxRow[];
    const byUser = new Map<string, OutboxRow[]>();
    for (const row of rows) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
    const directory = await people([...byUser.keys()]);
    for (const [userId, list] of byUser) {
      const person = directory.get(userId);
      if (!person) {
        await finish(list.map((r) => r.id), true, 0);
        continue;
      }
      // Solo lo que sigue «daily» y activo en sus preferencias de hoy
      const allowed: OutboxRow[] = [];
      for (const row of list) {
        const pref = (await loadPrefs([userId], row.event)).get(userId) ?? DEFAULTS[row.event];
        if (pref.channel === "email") allowed.push(row);
        else await admin.from("notification_outbox").update({ status: "skipped" }).eq("id", row.id);
      }
      if (allowed.length === 0) continue;
      const siteUrl = getSiteUrl();
      const token = signUnsubscribe(userId, "digest", salt);
      const mail = renderDigest(allowed.map((r) => ({ event: r.event, payload: r.payload })), { siteUrl, unsubscribeUrl: `${siteUrl}/baja/${token}`, dateLabel: dateLabel.format(new Date(now)) });
      const result = await sendMail(config, { to: person.email, ...mail, unsubscribeUrl: `${siteUrl}/baja/${token}`, oneClickUrl: `${siteUrl}/api/baja/${token}` });
      const attempts = Math.max(...allowed.map((r) => r.attempts)) + 1;
      await finish(allowed.map((r) => r.id), result.ok, attempts, result.ok ? undefined : result.error);
      if (result.ok) stats.sent++;
      else stats.failed++;
    }
  } catch (error) {
    console.error("sendDigests failed:", error instanceof Error ? error.name : "unknown");
  }
  return stats;
}

/** Avisa al creador de los enlaces que caducan en las próximas 24 horas (una sola vez por enlace). */
export async function sendExpiryReminders(now = Date.now()): Promise<number> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("share_links")
      .select("id, title, created_by")
      .is("revoked_at", null)
      .is("expiry_notified_at", null)
      .gt("expires_at", new Date(now).toISOString())
      .lte("expires_at", new Date(now + 24 * 3600_000).toISOString())
      .limit(200);
    const links = (data ?? []) as { id: string; title: string; created_by: string | null }[];
    for (const link of links) {
      const { error } = await admin.from("share_links").update({ expiry_notified_at: new Date(now).toISOString() }).eq("id", link.id).is("expiry_notified_at", null);
      if (error || !link.created_by) continue;
      await notify("link_expiring", { recipients: [link.created_by], groupKey: `link-expiring:${link.id}`, payload: { title: link.title, path: `/accesos?tab=enlaces&enlace=${link.id}` } });
    }
    return links.length;
  } catch {
    return 0;
  }
}
