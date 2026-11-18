import "server-only";

import type { Actor } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { notify, withAccess } from "./notify";

/**
 * Puntos de aviso del producto. Cada uno decide QUIÉN debe enterarse (siempre filtrando por acceso real) y llama a
 * `notify`, que nunca lanza ni bloquea. Nada del Vault entra aquí: las consultas excluyen `space = 'vault'`.
 */

/**
 * Subidas publicadas: UN aviso por artista y sesión aunque se publiquen cientos de archivos a la vez
 * (12 fotos → «12 archivos nuevos en Sesión X»). Avisa a quienes pertenecen al artista y pueden ver el material.
 */
export async function notifyPublished(actor: Pick<Actor, "id" | "displayName">, assetIds: string[]): Promise<void> {
  try {
    if (assetIds.length === 0) return;
    const admin = createAdminClient();
    const { data } = await admin.from("assets").select("id, artist_id, session_id, kind").in("id", assetIds.slice(0, 1000)).eq("space", "workspace").eq("visibility", "published").not("artist_id", "is", null);
    const rows = (data ?? []) as { id: string; artist_id: string; session_id: string | null; kind: string }[];
    const groups = new Map<string, typeof rows>();
    for (const r of rows) groups.set(`${r.artist_id}|${r.session_id ?? ""}`, [...(groups.get(`${r.artist_id}|${r.session_id ?? ""}`) ?? []), r]);
    for (const [key, list] of groups) {
      const [artistId, sessionId] = key.split("|") as [string, string];
      const [{ data: artist }, { data: members }, session] = await Promise.all([
        admin.from("artists").select("id, name, slug").eq("id", artistId).maybeSingle(),
        admin.from("artist_members").select("user_id").eq("artist_id", artistId),
        sessionId ? admin.from("sessions").select("id, name").eq("id", sessionId).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const a = artist as { id: string; name: string; slug: string } | null;
      if (!a) continue;
      const s = session.data as { id: string; name: string } | null;
      const recipients = await withAccess(((members ?? []) as { user_id: string }[]).map((m) => m.user_id), { type: "asset", id: (list[0] as { id: string }).id });
      await notify("upload_published", {
        recipients,
        actorId: actor.id,
        groupKey: `upload:${artistId}:${sessionId || "-"}`,
        assetIds: list.map((x) => x.id),
        payload: { title: s ? `la sesión «${s.name}»` : `el espacio de ${a.name}`, count: list.length, path: s ? `/espacio/${a.slug}/sesiones/${s.id}` : `/espacio/${a.slug}`, artistId, artistName: a.name, actorName: actor.displayName },
      });
    }
  } catch (error) {
    console.error("notifyPublished failed:", error instanceof Error ? error.name : "unknown");
  }
}

/** Invitación aceptada: avisa a quien la envió. */
export async function notifyInvitationAccepted(invitationId: string, newPerson: { id: string; name: string }): Promise<void> {
  try {
    const { data } = await createAdminClient().from("invitations").select("invited_by").eq("id", invitationId).maybeSingle();
    const inviter = (data as { invited_by: string | null } | null)?.invited_by;
    if (!inviter) return;
    await notify("invitation_accepted", { recipients: [inviter], actorId: newPerson.id, groupKey: `invite:${invitationId}`, payload: { title: "usuarios", path: "/usuarios", actorName: newPerson.name } });
  } catch (error) {
    console.error("notifyInvitationAccepted failed:", error instanceof Error ? error.name : "unknown");
  }
}

/** Beat compartido con un artista: avisa a las personas del artista que ya pueden verlo (publicado). */
export async function notifyBeatShared(actor: Pick<Actor, "id" | "displayName">, beatId: string, artistId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const [{ data: beat }, { data: artist }, { data: members }] = await Promise.all([
      admin.from("beats").select("id, title, status, asset_id").eq("id", beatId).is("deleted_at", null).maybeSingle(),
      admin.from("artists").select("id, name, slug").eq("id", artistId).maybeSingle(),
      admin.from("artist_members").select("user_id").eq("artist_id", artistId),
    ]);
    const b = beat as { id: string; title: string; status: string; asset_id: string } | null;
    const a = artist as { id: string; name: string; slug: string } | null;
    if (!b || !a || b.status !== "published") return; // un borrador no se anuncia
    const recipients = await withAccess(((members ?? []) as { user_id: string }[]).map((m) => m.user_id), { type: "beat", id: b.id });
    await notify("beat_shared", { recipients, actorId: actor.id, groupKey: `beat-shared:${artistId}`, assetIds: [b.asset_id], payload: { title: b.title, path: `/espacio/${a.slug}/beats`, artistId, artistName: a.name, actorName: actor.displayName } });
  } catch (error) {
    console.error("notifyBeatShared failed:", error instanceof Error ? error.name : "unknown");
  }
}
