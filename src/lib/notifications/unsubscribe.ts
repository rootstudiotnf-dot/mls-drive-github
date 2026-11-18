import "server-only";

import { getShareSalt } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULTS, EVENTS, type NotificationEvent } from "./events";
import { verifyUnsubscribe } from "./templates";

/** Baja desde el enlace del correo (firmado, sin iniciar sesión). «digest» = todos los resúmenes diarios. */
export function readUnsubscribe(token: string): { userId: string; event: NotificationEvent | "digest" } | null {
  const key = getShareSalt();
  return key ? verifyUnsubscribe(token, key) : null;
}

export async function applyUnsubscribe(token: string): Promise<boolean> {
  const parsed = readUnsubscribe(token);
  if (!parsed) return false;
  const admin = createAdminClient();
  if (parsed.event === "digest") {
    // Todo lo que llega en resumen diario se desactiva (solo los eventos que hoy son «daily» para esa persona)
    const { data } = await admin.from("notification_settings").select("event, channel, frequency").eq("user_id", parsed.userId);
    const current = new Map(((data ?? []) as { event: string; channel: string; frequency: string }[]).map((r) => [r.event, r]));
    const rows = EVENTS.filter((e) => (current.get(e)?.frequency ?? DEFAULTS[e].frequency) === "daily").map((e) => ({ user_id: parsed.userId, event: e, channel: "off", frequency: "daily", updated_at: new Date().toISOString() }));
    if (rows.length > 0) await admin.from("notification_settings").upsert(rows, { onConflict: "user_id,event" });
    return true;
  }
  const { data } = await admin.from("notification_settings").select("frequency").eq("user_id", parsed.userId).eq("event", parsed.event).maybeSingle();
  const frequency = (data as { frequency: string } | null)?.frequency ?? DEFAULTS[parsed.event].frequency;
  const { error } = await admin.from("notification_settings").upsert({ user_id: parsed.userId, event: parsed.event, channel: "off", frequency, updated_at: new Date().toISOString() }, { onConflict: "user_id,event" });
  return !error;
}
