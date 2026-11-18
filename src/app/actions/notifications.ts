"use server";

import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { getActor } from "@/lib/auth/session";
import { DEFAULTS, describe, isEvent, type Channel, type Frequency, type NotificationEvent, type NotificationPayload, type Preference } from "@/lib/notifications/events";
import { ForbiddenError, runAction } from "@/lib/permissions/server";
import { isUuid } from "@/lib/storage/keys";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** Bandeja interna (campana) y preferencias de avisos. Cada persona solo ve y cambia lo suyo. */

export type InboxItem = { id: string; type: NotificationEvent; text: string; path: string; read: boolean; createdAt: string };
export type Inbox = { items: InboxItem[]; unread: number };

async function me(): Promise<string> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  return actor.id;
}

export async function listNotifications(): Promise<ActionResult<Inbox>> {
  return runAction(async () => {
    await me();
    const supabase = await createClient(); // RLS: solo las suyas
    const [{ data }, { count }] = await Promise.all([
      supabase.from("notifications").select("id, type, payload, read_at, created_at").order("created_at", { ascending: false }).limit(20),
      supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null),
    ]);
    const rows = (data ?? []) as { id: string; type: string; payload: NotificationPayload; read_at: string | null; created_at: string }[];
    return ok<Inbox>(undefined, {
      unread: count ?? 0,
      items: rows.filter((r) => isEvent(r.type)).map((r) => ({ id: r.id, type: r.type as NotificationEvent, text: describe(r.type as NotificationEvent, r.payload), path: typeof r.payload?.path === "string" && r.payload.path.startsWith("/") ? r.payload.path : "/", read: r.read_at !== null, createdAt: r.created_at })),
    });
  });
}

export async function markNotificationRead(id: string): Promise<ActionResult> {
  return runAction(async () => {
    const userId = await me();
    if (!isUuid(id)) return fail(GENERIC_ERROR);
    await createAdminClient().from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id).eq("user_id", userId).is("read_at", null);
    return ok();
  });
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  return runAction(async () => {
    const userId = await me();
    await createAdminClient().from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", userId).is("read_at", null);
    return ok();
  });
}

// --- Preferencias ---------------------------------------------------------------------------------------------------------

export async function getPreferences(): Promise<ActionResult<Record<NotificationEvent, Preference>>> {
  return runAction(async () => {
    await me();
    const supabase = await createClient();
    const { data } = await supabase.from("notification_settings").select("event, channel, frequency");
    const out = { ...DEFAULTS } as Record<NotificationEvent, Preference>;
    for (const row of (data ?? []) as { event: string; channel: Channel; frequency: Frequency }[]) if (isEvent(row.event)) out[row.event] = { channel: row.channel, frequency: row.frequency };
    return ok(undefined, out);
  });
}

export async function savePreference(input: { event: string; channel: string; frequency: string }): Promise<ActionResult> {
  return runAction(async () => {
    const userId = await me();
    if (!isEvent(input?.event) || (input.channel !== "email" && input.channel !== "off") || (input.frequency !== "instant" && input.frequency !== "daily")) return fail(GENERIC_ERROR);
    const { error } = await createAdminClient().from("notification_settings").upsert({ user_id: userId, event: input.event, channel: input.channel, frequency: input.frequency, updated_at: new Date().toISOString() }, { onConflict: "user_id,event" });
    return error ? fail(GENERIC_ERROR) : ok("Guardado.");
  });
}

