"use server";

import { notifyBeatShared } from "@/lib/notifications/hooks";
import { after } from "next/server";
import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { getActor, type Actor } from "@/lib/auth/session";
import { signAssetUrl } from "@/lib/assets/urls";
import {
  BEAT_ORDERS,
  BPM_MAX,
  BPM_MIN,
  CATALOG_PAGE_SIZE,
  MUSICAL_KEYS,
  normalizeKey,
  type BeatOrder,
  type BeatRow,
  type BeatStatus,
  type CatalogFilters,
} from "@/lib/beats/types";
import { logActivity } from "@/lib/permissions/audit";
import { can, ForbiddenError, requirePermission, runAction, userHasPermission } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/storage/keys";
import { dispatchVideoJob, enqueueVideoJob } from "@/lib/video/jobs";

/**
 * Beat Library. Reglas (todas en servidor y base de datos; ocultar algo en la interfaz no basta):
 *  - LISTAR y VER: la base de datos decide (`beat_catalog` es SECURITY INVOKER → can_access por fila). Un artista no
 *    ve borradores, ni beats sin compartir con su artista, ni los de otros artistas.
 *  - ESCUCHAR: siempre el preview `audio_preview` con URL firmada de 15 min. El original nunca se reproduce.
 *  - DESCARGAR el original: `signAssetUrl(original, download)` → can_access con las tres capas (rol, beat descargable,
 *    can_download del artista o grant). Cada descarga queda en activity_log.
 *  - PUBLICAR: título, BPM, tonalidad, género y preview listo (también lo impone un trigger).
 *  - COMPARTIR: quien edita beats; nadie concede descarga si su rol no la tiene.
 */

async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  return actor;
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

export type BeatPage = { items: BeatRow[]; nextCursor: string | null };

type CatalogRow = {
  id: string;
  asset_id: string;
  title: string;
  bpm: number | null;
  musical_key: string | null;
  genre_id: string | null;
  genre_name: string | null;
  status: BeatStatus;
  created_on: string;
  downloadable: boolean;
  cover_asset_id: string | null;
  duration_seconds: number | null;
  preview_ready: boolean;
  tags: string[] | null;
  sort_val: string;
};

const uuids = (value: unknown, max = 30): string[] | null =>
  Array.isArray(value) && value.length > 0 && value.length <= max && value.every((v) => isUuid(v)) ? (value as string[]) : null;

/** Parsea y valida filtros (también los que vienen de la URL). Lo no válido se ignora. */
async function parseFilters(raw: unknown): Promise<CatalogFilters> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
  return {
    q: typeof r.q === "string" ? r.q.trim().slice(0, 80) || undefined : undefined,
    genres: uuids(r.genres) ?? undefined,
    bpmMin: num(r.bpmMin, BPM_MIN, BPM_MAX),
    bpmMax: num(r.bpmMax, BPM_MIN, BPM_MAX),
    keys: Array.isArray(r.keys) ? (r.keys.filter((k) => typeof k === "string" && MUSICAL_KEYS.includes(k)) as string[]).slice(0, 24) || undefined : undefined,
    tags: uuids(r.tags) ?? undefined,
    status: r.status === "draft" || r.status === "published" ? r.status : undefined,
    artist: isUuid(r.artist) ? r.artist : undefined,
    order: BEAT_ORDERS.find((o) => o === r.order),
  };
}

/** Una página del catálogo (50). Cursor opaco: `valor|id` del último elemento de la página anterior. */
export async function listBeats(input: { filters?: unknown; cursor?: string | null }): Promise<ActionResult<BeatPage>> {
  return runAction(async () => {
    await requireActor();
    const f = await parseFilters(input?.filters);
    const order: BeatOrder = f.order ?? "recent";
    let afterVal: string | null = null;
    let afterId: string | null = null;
    if (input?.cursor) {
      const cut = input.cursor.lastIndexOf("|");
      afterVal = input.cursor.slice(0, cut);
      afterId = input.cursor.slice(cut + 1);
      if (!isUuid(afterId) || afterVal.length > 200) return fail(GENERIC_ERROR);
    }
    const supabase = await createClient(); // RLS / can_access por fila: nunca se filtra «después»
    const { data, error } = await supabase.rpc("beat_catalog", {
      p_q: f.q ?? null,
      p_genres: f.genres ?? null,
      p_bpm_min: f.bpmMin ?? null,
      p_bpm_max: f.bpmMax ?? null,
      p_keys: f.keys ?? null,
      p_tags: f.tags ?? null,
      p_status: f.status ?? null,
      p_artist: f.artist ?? null,
      p_order: order,
      p_after_val: afterVal,
      p_after_id: afterId,
      p_limit: CATALOG_PAGE_SIZE + 1,
    });
    if (error) return fail(GENERIC_ERROR);
    const rows = (data ?? []) as unknown as CatalogRow[];
    const page = rows.slice(0, CATALOG_PAGE_SIZE);

    // «Compartido con»: lectura bajo RLS (cada artista solo ve sus propios compartidos)
    const shares = new Map<string, BeatRow["sharedWith"]>();
    if (page.length > 0) {
      const { data: rel } = await supabase.from("beat_artists").select("beat_id, artist_id, can_download").in("beat_id", page.map((r) => r.id));
      const links = (rel ?? []) as { beat_id: string; artist_id: string; can_download: boolean }[];
      const names = new Map<string, string>();
      const artistIds = [...new Set(links.map((l) => l.artist_id))];
      if (artistIds.length > 0) {
        const { data: artists } = await createAdminClient().from("artists").select("id, name").in("id", artistIds);
        for (const a of (artists ?? []) as { id: string; name: string }[]) names.set(a.id, a.name);
      }
      for (const l of links) shares.set(l.beat_id, [...(shares.get(l.beat_id) ?? []), { artistId: l.artist_id, name: names.get(l.artist_id) ?? "Artista", canDownload: l.can_download }]);
    }

    const last = page[page.length - 1];
    return ok<BeatPage>(undefined, {
      items: page.map((r) => ({
        id: r.id,
        assetId: r.asset_id,
        title: r.title,
        bpm: r.bpm,
        key: r.musical_key,
        genreId: r.genre_id,
        genre: r.genre_name,
        status: r.status,
        createdOn: r.created_on,
        downloadable: r.downloadable,
        coverAssetId: r.cover_asset_id,
        durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
        previewReady: r.preview_ready,
        tags: r.tags ?? [],
        sharedWith: shares.get(r.id) ?? [],
      })),
      nextCursor: rows.length > CATALOG_PAGE_SIZE && last ? `${last.sort_val}|${last.id}` : null,
    });
  });
}

// ---------------------------------------------------------------------------
// Reproducir y descargar
// ---------------------------------------------------------------------------

export type Playback = { beatId: string; title: string; url: string; expiresIn: number; waveform: number[] | null; durationSeconds: number | null; coverAssetId: string | null };

async function loadBeatAsset(beatId: unknown): Promise<{ id: string; asset_id: string; title: string; waveform: number[] | null; cover_asset_id: string | null }> {
  if (!isUuid(beatId)) throw new ForbiddenError();
  const { data } = await createAdminClient().from("beats").select("id, asset_id, title, waveform, cover_asset_id").eq("id", beatId).is("deleted_at", null).maybeSingle();
  if (!data) throw new ForbiddenError();
  return data as { id: string; asset_id: string; title: string; waveform: number[] | null; cover_asset_id: string | null };
}

/** URL firmada (15 min, con Range) del PREVIEW del beat. Solo si la persona puede verlo (can_access). */
export async function getBeatPlayback(beatId: string): Promise<ActionResult<Playback>> {
  return runAction(async () => {
    const actor = await requireActor();
    const beat = await loadBeatAsset(beatId);
    if (!(await can(actor.id, "view", { type: "beat", id: beat.id }))) throw new ForbiddenError();
    const signed = await signAssetUrl(actor, beat.asset_id, "audio_preview", "view");
    if (!signed.ok || !signed.data) return fail("El preview aún no está disponible.");
    const { data: asset } = await createAdminClient().from("assets").select("duration_seconds").eq("id", beat.asset_id).maybeSingle();
    const duration = (asset as { duration_seconds: number | null } | null)?.duration_seconds;
    return ok<Playback>(undefined, {
      beatId: beat.id,
      title: beat.title,
      url: signed.data.url,
      expiresIn: signed.data.expiresIn,
      waveform: Array.isArray(beat.waveform) ? beat.waveform : null,
      durationSeconds: duration === null || duration === undefined ? null : Number(duration),
      coverAssetId: beat.cover_asset_id,
    });
  });
}

/** Registra una escucha: como máximo una vez por persona y beat cada hora. */
export async function logBeatPlay(beatId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const beat = await loadBeatAsset(beatId);
    if (!(await can(actor.id, "view", { type: "beat", id: beat.id }))) throw new ForbiddenError();
    const admin = createAdminClient();
    const { data: recent } = await admin
      .from("activity_log")
      .select("id")
      .eq("actor_id", actor.id)
      .eq("action", "beat.play")
      .eq("resource_id", beat.id)
      .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
      .limit(1);
    if ((recent?.length ?? 0) > 0) return ok();
    await logActivity({ actorId: actor.id, action: "beat.play", resourceType: "beat", resourceId: beat.id, metadata: { title: beat.title } });
    return ok();
  });
}

/** URL de descarga (2 min, attachment con el título) del ORIGINAL: exige las tres capas (can_access lo comprueba). */
export async function getBeatDownloadUrl(beatId: string): Promise<ActionResult<{ url: string }>> {
  return runAction(async () => {
    const actor = await requireActor();
    const beat = await loadBeatAsset(beatId);
    const signed = await signAssetUrl(actor, beat.asset_id, "original", "download");
    if (!signed.ok || !signed.data) return fail("No tienes permiso para descargar este beat.");
    return ok<{ url: string }>(undefined, { url: signed.data.url });
  });
}

// ---------------------------------------------------------------------------
// Edición
// ---------------------------------------------------------------------------

export type BeatUpdate = {
  title?: string;
  bpm?: number | null;
  key?: string | null;
  genreId?: string | null;
  createdOn?: string;
  downloadable?: boolean;
  status?: BeatStatus;
  previewTagged?: boolean;
};

export async function updateBeat(beatId: string, raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(beatId) || !raw || typeof raw !== "object") return fail(GENERIC_ERROR);
    if (!(await can(actor.id, "edit", { type: "beat", id: beatId }))) throw new ForbiddenError();
    await requirePermission("beats.edit");
    const input = raw as Record<string, unknown>;
    const update: Record<string, unknown> = {};

    if (input.title !== undefined) {
      const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
      if (title.length < 1 || title.length > 120) return fail("El título debe tener entre 1 y 120 caracteres.");
      update.title = title;
    }
    if (input.bpm !== undefined) {
      if (input.bpm !== null && !(Number.isInteger(input.bpm) && (input.bpm as number) >= BPM_MIN && (input.bpm as number) <= BPM_MAX)) return fail(`El BPM debe estar entre ${BPM_MIN} y ${BPM_MAX}.`);
      update.bpm = input.bpm;
    }
    if (input.key !== undefined) {
      const key = input.key === null || input.key === "" ? null : typeof input.key === "string" ? normalizeKey(input.key) : undefined;
      if (key === undefined || (key !== null && !MUSICAL_KEYS.includes(key))) return fail("La tonalidad no es válida.");
      update.musical_key = key;
    }
    if (input.genreId !== undefined) {
      if (input.genreId !== null && !isUuid(input.genreId)) return fail("Género no válido.");
      if (input.genreId) {
        const { data } = await createAdminClient().from("genres").select("id").eq("id", input.genreId).maybeSingle();
        if (!data) return fail("Ese género no existe.");
      }
      update.genre_id = input.genreId;
    }
    if (input.createdOn !== undefined) {
      if (typeof input.createdOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.createdOn) || Number.isNaN(Date.parse(input.createdOn))) return fail("La fecha no es válida.");
      update.created_on = input.createdOn;
    }
    if (input.downloadable !== undefined) {
      if (typeof input.downloadable !== "boolean") return fail(GENERIC_ERROR);
      update.downloadable = input.downloadable;
    }
    if (input.previewTagged !== undefined) {
      if (typeof input.previewTagged !== "boolean") return fail(GENERIC_ERROR);
      update.preview_tagged = input.previewTagged;
    }
    let publishing = false;
    if (input.status !== undefined) {
      if (input.status !== "draft" && input.status !== "published") return fail(GENERIC_ERROR);
      // Publicar y despublicar exigen beats.publish
      if (!(await can(actor.id, "publish", { type: "beat", id: beatId }))) throw new ForbiddenError();
      update.status = input.status;
      publishing = input.status === "published";
    }
    if (Object.keys(update).length === 0) return ok("Sin cambios.");

    const admin = createAdminClient();
    const { data: before } = await admin.from("beats").select("asset_id, preview_tagged").eq("id", beatId).is("deleted_at", null).maybeSingle();
    const current = before as { asset_id: string; preview_tagged: boolean } | null;
    if (!current) return fail("Ese beat no existe.");
    const { error } = await admin.from("beats").update(update).eq("id", beatId);
    if (error) {
      // Los triggers de la base de datos explican qué falta para publicar
      return fail(error.code === "P0001" ? (error.message || "No se puede publicar todavía.") : GENERIC_ERROR);
    }
    await logActivity({ actorId: actor.id, action: publishing ? "beat.published" : input.status === "draft" ? "beat.unpublished" : "beat.updated", resourceType: "beat", resourceId: beatId, metadata: { fields: Object.keys(update) } });

    // Cambiar el tag de voz exige reprocesar el preview
    if (update.preview_tagged !== undefined && update.preview_tagged !== current.preview_tagged) {
      const jobId = await enqueueVideoJob(current.asset_id, "audio");
      if (jobId) after(() => void dispatchVideoJob(jobId));
    }
    return ok("Guardado.");
  });
}

/**
 * Asigna la portada (imagen 1:1 ya subida con `purpose: "beat-cover"` por quien llama). La portada anterior se manda
 * a la papelera: la clave del objeto nunca cambia ni se reutiliza.
 */
export async function setBeatCover(beatId: string, assetId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(beatId) || !isUuid(assetId)) return fail(GENERIC_ERROR);
    if (!(await can(actor.id, "edit", { type: "beat", id: beatId }))) throw new ForbiddenError();
    await requirePermission("beats.edit");
    const admin = createAdminClient();
    const { data } = await admin.from("assets").select("id, kind, status, uploaded_by, meta").eq("id", assetId).is("deleted_at", null).maybeSingle();
    const asset = data as { kind: string; status: string; uploaded_by: string | null; meta: { purpose?: string } | null } | null;
    if (!asset || asset.uploaded_by !== actor.id || asset.kind !== "photo" || asset.status !== "ready" || asset.meta?.purpose !== "beat-cover") {
      return fail("La portada no es válida.");
    }
    const { data: beat } = await admin.from("beats").select("cover_asset_id").eq("id", beatId).is("deleted_at", null).maybeSingle();
    if (!beat) return fail("Ese beat no existe.");
    const previous = (beat as { cover_asset_id: string | null }).cover_asset_id;
    const { error } = await admin.from("beats").update({ cover_asset_id: assetId }).eq("id", beatId);
    if (error) return fail(GENERIC_ERROR);
    if (previous && previous !== assetId) await admin.from("assets").update({ deleted_at: new Date().toISOString() }).eq("id", previous);
    await logActivity({ actorId: actor.id, action: "beat.cover_changed", resourceType: "beat", resourceId: beatId });
    return ok("Portada actualizada.");
  });
}

/** El borrador que se creó al terminar de subir un audio (solo de quien lo subió). */
export async function findBeatForAsset(assetId: string): Promise<ActionResult<{ id: string; title: string; bpm: number | null; key: string | null }>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(assetId)) return fail(GENERIC_ERROR);
    const admin = createAdminClient();
    const { data: asset } = await admin.from("assets").select("uploaded_by").eq("id", assetId).maybeSingle();
    if ((asset as { uploaded_by: string | null } | null)?.uploaded_by !== actor.id) throw new ForbiddenError();
    const { data } = await admin.from("beats").select("id, title, bpm, musical_key").eq("asset_id", assetId).is("deleted_at", null).maybeSingle();
    const beat = data as { id: string; title: string; bpm: number | null; musical_key: string | null } | null;
    if (!beat) return fail("Todavía no hay borrador.");
    return ok(undefined, { id: beat.id, title: beat.title, bpm: beat.bpm, key: beat.musical_key });
  });
}

export type BeatActivityEntry = { id: string; actorName: string; action: string; createdAt: string };

/** Actividad del beat (publicaciones, cambios, accesos, descargas). Solo para quien puede editarlo. */
export async function listBeatActivity(beatId: string): Promise<ActionResult<BeatActivityEntry[]>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(beatId)) return fail(GENERIC_ERROR);
    if (!(await can(actor.id, "edit", { type: "beat", id: beatId }))) throw new ForbiddenError();
    const admin = createAdminClient();
    const { data: beat } = await admin.from("beats").select("asset_id").eq("id", beatId).maybeSingle();
    const assetId = (beat as { asset_id: string } | null)?.asset_id;
    // Del propio beat (`beat.*`) y de su archivo de audio (descargas, comentarios, procesado)
    const { data } = await admin
      .from("activity_log")
      .select("id, actor_id, action, created_at, resource_type, resource_id")
      .or(`and(resource_type.eq.beat,resource_id.eq.${beatId})${assetId ? `,and(resource_type.eq.asset,resource_id.eq.${assetId})` : ""}`)
      .neq("action", "beat.play")
      .order("created_at", { ascending: false })
      .limit(40);
    const rows = (data ?? []) as { id: string; actor_id: string | null; action: string; created_at: string }[];
    const ids = [...new Set(rows.map((r) => r.actor_id).filter((v): v is string => !!v))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const { data: people } = await admin.from("profiles").select("id, full_name, email").in("id", ids);
      for (const p of (people ?? []) as { id: string; full_name: string | null; email: string }[]) names.set(p.id, p.full_name || p.email.split("@")[0] || "Alguien");
    }
    return ok<BeatActivityEntry[]>(undefined, rows.map((r) => ({ id: r.id, actorName: r.actor_id ? (names.get(r.actor_id) ?? "Alguien") : "Sistema", action: r.action, createdAt: r.created_at })));
  });
}

/** Etiquetas del beat (sustituye el conjunto). Se crean las que no existan. */
export async function setBeatTags(beatId: string, names: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(beatId) || !Array.isArray(names)) return fail(GENERIC_ERROR);
    if (!(await can(actor.id, "edit", { type: "beat", id: beatId }))) throw new ForbiddenError();
    await requirePermission("beats.edit");
    const clean = [...new Set(names.map((n) => (typeof n === "string" ? n.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 30) : "")).filter(Boolean))].slice(0, 15);
    const admin = createAdminClient();
    if (clean.length > 0) await admin.from("tags").upsert(clean.map((name) => ({ name })), { onConflict: "name", ignoreDuplicates: true });
    const { data: tags } = clean.length > 0 ? await admin.from("tags").select("id, name").in("name", clean) : { data: [] };
    const wanted = new Set(((tags ?? []) as { id: string }[]).map((t) => t.id));
    const { data: current } = await admin.from("taggings").select("id, tag_id").eq("resource_type", "beat").eq("resource_id", beatId);
    const have = new Map(((current ?? []) as { id: string; tag_id: string }[]).map((t) => [t.tag_id, t.id]));
    const remove = [...have].filter(([tagId]) => !wanted.has(tagId)).map(([, id]) => id);
    const add = [...wanted].filter((tagId) => !have.has(tagId));
    if (remove.length > 0) await admin.from("taggings").delete().in("id", remove);
    if (add.length > 0) await admin.from("taggings").insert(add.map((tag_id) => ({ tag_id, resource_type: "beat", resource_id: beatId })));
    await logActivity({ actorId: actor.id, action: "beat.updated", resourceType: "beat", resourceId: beatId, metadata: { fields: ["tags"] } });
    return ok("Etiquetas guardadas.");
  });
}

/** Autocompletado de etiquetas (por prefijo). */
export async function suggestTags(prefix: string): Promise<ActionResult<string[]>> {
  return runAction(async () => {
    // Las etiquetas son comunes a todos los beats: solo las ve quien las edita (el autocompletado es del editor)
    await requirePermission("beats.edit");
    const p = String(prefix ?? "").toLowerCase().replace(/[%_\\]/g, "").trim().slice(0, 30);
    const supabase = await createClient();
    const { data } = await supabase.from("tags").select("name").ilike("name", `${p}%`).order("name").limit(8);
    return ok<string[]>(undefined, ((data ?? []) as { name: string }[]).map((t) => t.name));
  });
}

/** Reprocesa el preview (owner/admin: quien puede publicar). */
export async function reprocessBeat(beatId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const beat = await loadBeatAsset(beatId);
    if (!(await can(actor.id, "publish", { type: "beat", id: beat.id }))) throw new ForbiddenError();
    const jobId = await enqueueVideoJob(beat.asset_id, "audio");
    if (!jobId) return fail("Ya se está procesando este beat.");
    await logActivity({ actorId: actor.id, action: "beat.reprocess", resourceType: "beat", resourceId: beat.id });
    after(() => void dispatchVideoJob(jobId));
    return ok("Reprocesando…");
  });
}

// ---------------------------------------------------------------------------
// Compartir con artistas
// ---------------------------------------------------------------------------

export async function shareBeat(beatId: string, artistId: string, canDownload: boolean): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(beatId) || !isUuid(artistId) || typeof canDownload !== "boolean") return fail(GENERIC_ERROR);
    if (!(await can(actor.id, "edit", { type: "beat", id: beatId }))) throw new ForbiddenError();
    await requirePermission("beats.edit");
    // Anti-escalada: nadie concede descarga si su propio rol no la tiene
    if (canDownload && !(await userHasPermission(actor.id, "beats.download"))) throw new ForbiddenError();
    const admin = createAdminClient();
    const { data: artist } = await admin.from("artists").select("id").eq("id", artistId).is("deleted_at", null).maybeSingle();
    if (!artist) return fail("Ese artista no existe.");
    const { error } = await admin.from("beat_artists").upsert({ beat_id: beatId, artist_id: artistId, can_download: canDownload, created_by: actor.id }, { onConflict: "beat_id,artist_id" });
    if (error) return fail(GENERIC_ERROR);
    await logActivity({ actorId: actor.id, action: "beat.shared", resourceType: "beat", resourceId: beatId, metadata: { artistId, canDownload } });
    after(() => void notifyBeatShared(actor, beatId, artistId));
    return ok("Compartido.");
  });
}

export async function unshareBeat(beatId: string, artistId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(beatId) || !isUuid(artistId)) return fail(GENERIC_ERROR);
    if (!(await can(actor.id, "edit", { type: "beat", id: beatId }))) throw new ForbiddenError();
    await requirePermission("beats.edit");
    const { error } = await createAdminClient().from("beat_artists").delete().eq("beat_id", beatId).eq("artist_id", artistId);
    if (error) return fail(GENERIC_ERROR);
    await logActivity({ actorId: actor.id, action: "beat.unshared", resourceType: "beat", resourceId: beatId, metadata: { artistId } });
    return ok("Dejó de compartirse.");
  });
}

// ---------------------------------------------------------------------------
// Géneros
// ---------------------------------------------------------------------------

function cleanName(value: unknown): string | null {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return name.length >= 1 && name.length <= 40 ? name : null;
}

export async function createGenre(rawName: string): Promise<ActionResult<{ id: string; name: string }>> {
  return runAction(async () => {
    await requireActor();
    await requirePermission("beats.edit");
    const name = cleanName(rawName);
    if (!name) return fail("El nombre debe tener entre 1 y 40 caracteres.");
    const admin = createAdminClient();
    const { data: existing } = await admin.from("genres").select("id, name").ilike("name", name).maybeSingle();
    if (existing) return ok<{ id: string; name: string }>("Ya existía.", existing as { id: string; name: string });
    const { data, error } = await admin.from("genres").insert({ name }).select("id, name").single();
    if (error || !data) return fail(GENERIC_ERROR);
    return ok<{ id: string; name: string }>("Género creado.", data as { id: string; name: string });
  });
}

export async function renameGenre(genreId: string, rawName: string): Promise<ActionResult> {
  return runAction(async () => {
    await requireActor();
    await requirePermission("beats.edit");
    const name = cleanName(rawName);
    if (!isUuid(genreId) || !name) return fail("El nombre debe tener entre 1 y 40 caracteres.");
    const { error } = await createAdminClient().from("genres").update({ name }).eq("id", genreId);
    return error ? fail(error.code === "23505" ? "Ya existe un género con ese nombre." : GENERIC_ERROR) : ok("Renombrado.");
  });
}

/** Fusiona `fromId` en `intoId`: sus beats pasan al destino y el género de origen se borra. */
export async function mergeGenres(fromId: string, intoId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    await requirePermission("beats.edit");
    if (!isUuid(fromId) || !isUuid(intoId) || fromId === intoId) return fail("Elige dos géneros distintos.");
    const admin = createAdminClient();
    const { error } = await admin.from("beats").update({ genre_id: intoId }).eq("genre_id", fromId);
    if (error) return fail(GENERIC_ERROR);
    await admin.from("genres").delete().eq("id", fromId);
    // El índice de búsqueda de los beats movidos se refresca al cambiar su género (trigger)
    await logActivity({ actorId: actor.id, action: "genre.merged", resourceType: "genre", resourceId: intoId, metadata: { from: fromId } });
    return ok("Géneros fusionados.");
  });
}

/** Solo se borran géneros sin uso. */
export async function deleteGenre(genreId: string): Promise<ActionResult> {
  return runAction(async () => {
    await requireActor();
    await requirePermission("beats.edit");
    if (!isUuid(genreId)) return fail(GENERIC_ERROR);
    const admin = createAdminClient();
    const { data: used } = await admin.from("beats").select("id").eq("genre_id", genreId).is("deleted_at", null).limit(1);
    if ((used?.length ?? 0) > 0) return fail("Hay beats con este género: fusiónalo con otro antes de borrarlo.");
    const { error } = await admin.from("genres").delete().eq("id", genreId);
    return error ? fail(GENERIC_ERROR) : ok("Género borrado.");
  });
}

// ---------------------------------------------------------------------------
// Ajustes del tag de voz (solo owner)
// ---------------------------------------------------------------------------

export async function saveBeatSettings(input: { intervalS: number; defaultTagged: boolean; voiceTagAssetId?: string | null }): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    if (actor.roleKey !== "owner") throw new ForbiddenError();
    if (!Number.isInteger(input?.intervalS) || input.intervalS < 5 || input.intervalS > 600 || typeof input.defaultTagged !== "boolean") return fail("El intervalo debe estar entre 5 y 600 segundos.");
    const admin = createAdminClient();
    const rows: { key: string; value: unknown }[] = [
      { key: "beat_voice_tag_interval_s", value: input.intervalS },
      { key: "beat_voice_tag_default", value: input.defaultTagged },
    ];
    if (input.voiceTagAssetId !== undefined) {
      if (input.voiceTagAssetId !== null) {
        if (!isUuid(input.voiceTagAssetId)) return fail(GENERIC_ERROR);
        const { data } = await admin.from("assets").select("id, kind, meta").eq("id", input.voiceTagAssetId).eq("status", "ready").is("deleted_at", null).maybeSingle();
        const asset = data as { kind: string; meta: { purpose?: string } | null } | null;
        if (!asset || asset.kind !== "audio" || asset.meta?.purpose !== "voice-tag") return fail("Ese archivo no es un tag de voz válido.");
      }
      rows.push({ key: "beat_voice_tag_asset_id", value: input.voiceTagAssetId });
    }
    const { error } = await admin.from("app_settings").upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: "key" });
    if (error) return fail(GENERIC_ERROR);
    await logActivity({ actorId: actor.id, action: "beat.settings_changed", resourceType: "beat", resourceId: null });
    return ok("Ajustes guardados.");
  });
}
