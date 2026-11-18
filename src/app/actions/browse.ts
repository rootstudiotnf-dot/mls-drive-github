"use server";

import { after } from "next/server";
import { notifyPublished } from "@/lib/notifications/hooks";
import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { getActor, type Actor } from "@/lib/auth/session";
import { loadFolderTree } from "@/lib/artists/data";
import { loadAssetRow, moveAssetOp, moveToSessionOp, purgeAssetOp, restoreAssetOp, setVisibilityOp, trashAssetOp } from "@/lib/assets/ops";
import { can, ForbiddenError, runAction, userHasPermission } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/storage/keys";
import { signGetUrl } from "@/lib/storage/urls";
import { AREA_OF_CLASS, type UploadClass } from "@/lib/storage/validate";

/**
 * Listados del espacio de un artista (paginados por cursor, 48 por página), miniaturas, actividad,
 * papelera y acciones en lote.
 *
 * Los LISTADOS se piden con el cliente del usuario: es RLS (can_access) quien decide qué filas llegan;
 * nunca se traen filas ajenas para ocultarlas después. La `storage_key` no se selecciona jamás.
 * Las ACCIONES (lote, restaurar, eliminar) comprueban el permiso asset a asset.
 */

const PAGE_SIZE = 48;
const MAX_BATCH = 200;

export type AssetTab = "todo" | "photos" | "videos" | "files";

export type AssetCard = {
  id: string;
  kind: UploadClass | "other";
  title: string;
  filename: string;
  folderId: string | null;
  visibility: "private" | "published";
  downloadable: boolean;
  uploaderId: string | null;
  uploaderName: string | null;
  createdAt: string;
  sizeBytes: number;
  durationSeconds: number | null;
};

export type AssetPage = { items: AssetCard[]; nextCursor: string | null };

type AssetRecord = {
  id: string;
  kind: AssetCard["kind"];
  title: string | null;
  original_filename: string;
  folder_id: string | null;
  visibility: "private" | "published";
  downloadable: boolean;
  uploaded_by: string | null;
  created_at: string;
  size_bytes: number | null;
  duration_seconds: number | null;
};

const CARD_COLUMNS =
  "id, kind, title, original_filename, folder_id, visibility, downloadable, uploaded_by, created_at, size_bytes, duration_seconds";

async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  return actor;
}

type FolderRecord = { id: string; parent_id: string | null };

/** La carpeta elegida y todas sus descendientes (para listar «con subcarpetas»). */
async function folderAndDescendants(artistId: string, folderId: string): Promise<string[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("folders").select("id, parent_id").eq("artist_id", artistId);
  const all = (data ?? []) as FolderRecord[];
  const out = [folderId];
  for (let i = 0; i < out.length; i++) {
    for (const f of all) if (f.parent_id === out[i] && !out.includes(f.id)) out.push(f.id);
  }
  return out;
}

export type ListAssetsInput = {
  artistId: string;
  tab: AssetTab;
  folderId?: string | null;
  q?: string;
  cursor?: string | null;
  /** Portal: solo lo publicado o lo subido por la propia persona. */
  portal?: boolean;
};

/** Texto de búsqueda seguro para un filtro de PostgREST (sin comas, paréntesis ni comodines). */
function safeSearch(q: string): string {
  return q.replace(/[,()%*_\\"']/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export async function listArtistAssets(raw: unknown): Promise<ActionResult<AssetPage>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!raw || typeof raw !== "object") return fail(GENERIC_ERROR);
    const input = raw as Partial<ListAssetsInput>;
    if (!isUuid(input.artistId)) return fail(GENERIC_ERROR);
    const tab = input.tab;
    if (tab !== "todo" && tab !== "photos" && tab !== "videos" && tab !== "files") return fail(GENERIC_ERROR);

    const supabase = await createClient(); // RLS: can_access('view') filtra cada fila
    let query = supabase
      .from("assets")
      .select(CARD_COLUMNS)
      .eq("artist_id", input.artistId)
      .eq("status", "ready")
      .eq("space", "workspace")
      .is("deleted_at", null);

    // El avatar del artista es parte de su ficha, no de sus archivos: no aparece en los listados
    const { data: artistRow } = await supabase.from("artists").select("avatar_asset_id").eq("id", input.artistId).maybeSingle();
    const avatarId = (artistRow as { avatar_asset_id: string | null } | null)?.avatar_asset_id;
    if (avatarId && isUuid(avatarId)) query = query.neq("id", avatarId);

    if (tab === "photos") query = query.eq("kind", "photo");
    else if (tab === "videos") query = query.eq("kind", "video");
    else if (tab === "files") query = query.in("kind", ["document", "audio", "other"]);

    if (input.folderId) {
      if (!isUuid(input.folderId)) return fail(GENERIC_ERROR);
      query = query.in("folder_id", await folderAndDescendants(input.artistId, input.folderId));
    }
    const q = safeSearch(input.q ?? "");
    if (q) query = query.or(`title.ilike.%${q}%,original_filename.ilike.%${q}%`);
    if (input.portal) query = query.or(`visibility.eq.published,uploaded_by.eq.${actor.id}`);

    if (input.cursor) {
      const [at, id] = input.cursor.split("|");
      if (!at || !isUuid(id) || Number.isNaN(Date.parse(at))) return fail(GENERIC_ERROR);
      query = query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE_SIZE + 1);
    if (error) return fail(GENERIC_ERROR);

    const rows = (data ?? []) as unknown as AssetRecord[];
    const page = rows.slice(0, PAGE_SIZE);

    // Nombres de quien subió (RLS: solo los que el usuario puede leer)
    const uploaderIds = [...new Set(page.map((r) => r.uploaded_by).filter((v): v is string => !!v))];
    const names = new Map<string, string>();
    if (uploaderIds.length > 0) {
      const { data: profiles } = await supabase.from("profiles").select("id, full_name, email").in("id", uploaderIds);
      for (const p of (profiles ?? []) as { id: string; full_name: string | null; email: string }[]) {
        names.set(p.id, p.full_name || p.email);
      }
    }

    const items: AssetCard[] = page.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title ?? r.original_filename,
      filename: r.original_filename,
      folderId: r.folder_id,
      visibility: r.visibility,
      downloadable: r.downloadable,
      uploaderId: r.uploaded_by,
      uploaderName: r.uploaded_by ? (names.get(r.uploaded_by) ?? null) : null,
      createdAt: r.created_at,
      sizeBytes: r.size_bytes ?? 0,
      durationSeconds: r.duration_seconds,
    }));
    const last = page[page.length - 1];
    return ok<AssetPage>(undefined, {
      items,
      nextCursor: rows.length > PAGE_SIZE && last ? `${last.created_at}|${last.id}` : null,
    });
  });
}

/** Carpetas de un artista (indentadas por nivel) para el diálogo de mover. Solo las que RLS deja ver. */
export async function listArtistFolders(artistId: string): Promise<ActionResult<{ id: string; label: string; kind: string }[]>> {
  return runAction(async () => {
    await requireActor();
    if (!isUuid(artistId)) return fail(GENERIC_ERROR);
    const tree = await loadFolderTree(artistId);
    return ok<{ id: string; label: string; kind: string }[]>(
      undefined,
      tree.map((f) => ({ id: f.id, label: `${"— ".repeat(f.depth)}${f.name}`, kind: f.kind })),
    );
  });
}

// ---------------------------------------------------------------------------
// Miniaturas: una sola llamada para toda la página
// ---------------------------------------------------------------------------

/**
 * URLs firmadas (5 min) de las miniaturas de varios assets. Solo se firman los que el usuario PUEDE ver:
 * se comprueba con una lectura bajo RLS, no con lo que diga el cliente.
 */
export async function getThumbUrls(assetIds: string[], variant: "thumb" | "web" | "poster" = "thumb"): Promise<ActionResult<Record<string, string>>> {
  return runAction(async () => {
    await requireActor();
    const type = variant === "web" ? "web" : variant === "poster" ? "poster" : "thumb";
    // Hasta 50 por llamada; cada foto se autoriza por separado (la lectura bajo RLS solo devuelve las visibles)
    const ids = Array.isArray(assetIds) ? [...new Set(assetIds.filter((v) => isUuid(v)))].slice(0, 50) : [];
    if (ids.length === 0) return ok<Record<string, string>>(undefined, {});

    const supabase = await createClient();
    const { data: visible } = await supabase.from("assets").select("id").in("id", ids).eq("status", "ready").is("deleted_at", null);
    const allowed = ((visible ?? []) as { id: string }[]).map((r) => r.id);
    if (allowed.length === 0) return ok<Record<string, string>>(undefined, {});

    const { data: derivatives } = await createAdminClient()
      .from("asset_derivatives")
      .select("asset_id, storage_key")
      .in("asset_id", allowed)
      .eq("type", type)
      .eq("status", "ready");
    const out: Record<string, string> = {};
    await Promise.all(
      ((derivatives ?? []) as { asset_id: string; storage_key: string }[]).map(async (d) => {
        const signed = await signGetUrl({ key: d.storage_key, mode: "view", contentType: type === "poster" ? "image/jpeg" : "image/webp" });
        out[d.asset_id] = signed.url;
      }),
    );
    return ok<Record<string, string>>(undefined, out);
  });
}

// ---------------------------------------------------------------------------
// Actividad del artista
// ---------------------------------------------------------------------------

export type ActivityEntry = {
  id: string;
  actorName: string;
  action: string;
  detail: string | null;
  createdAt: string;
};
export type ActivityPage = { items: ActivityEntry[]; nextCursor: string | null };

const ACTIVITY_PAGE = 30;

export async function listArtistActivity(raw: unknown): Promise<ActionResult<ActivityPage>> {
  return runAction(async () => {
    await requireActor();
    if (!raw || typeof raw !== "object") return fail(GENERIC_ERROR);
    const input = raw as { artistId?: string; cursor?: string | null };
    if (!isUuid(input.artistId)) return fail(GENERIC_ERROR);

    let beforeAt: string | null = null;
    let beforeId: string | null = null;
    if (input.cursor) {
      const [at, id] = input.cursor.split("|");
      if (!at || !isUuid(id) || Number.isNaN(Date.parse(at))) return fail(GENERIC_ERROR);
      beforeAt = at;
      beforeId = id;
    }

    // La función de base de datos solo devuelve filas a quien tiene access.manage
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("artist_activity", {
      p_artist: input.artistId,
      p_before_at: beforeAt,
      p_before_id: beforeId,
      p_limit: ACTIVITY_PAGE + 1,
    });
    if (error) return fail(GENERIC_ERROR);
    const rows = (data ?? []) as {
      id: string;
      actor_id: string | null;
      action: string;
      resource_type: string | null;
      resource_id: string | null;
      metadata: Record<string, unknown> | null;
      created_at: string;
    }[];
    const page = rows.slice(0, ACTIVITY_PAGE);

    const actorIds = [...new Set(page.map((r) => r.actor_id).filter((v): v is string => !!v))];
    const assetIds = [...new Set(page.filter((r) => r.resource_type === "asset" && r.resource_id).map((r) => r.resource_id as string))];
    const [people, assets] = await Promise.all([
      actorIds.length > 0 ? supabase.from("profiles").select("id, full_name, email").in("id", actorIds) : { data: [] },
      // Lectura de servidor (los assets borrados no son visibles por RLS): solo el título, tras haber pasado
      // por la función de actividad que ya exige access.manage.
      assetIds.length > 0 ? createAdminClient().from("assets").select("id, title, original_filename").in("id", assetIds) : { data: [] },
    ]);
    const names = new Map(((people.data ?? []) as { id: string; full_name: string | null; email: string }[]).map((p) => [p.id, p.full_name || p.email]));
    const titles = new Map(((assets.data ?? []) as { id: string; title: string | null; original_filename: string }[]).map((a) => [a.id, a.title || a.original_filename]));

    const last = page[page.length - 1];
    return ok<ActivityPage>(undefined, {
      items: page.map((r) => {
        const meta = r.metadata ?? {};
        const detail =
          (r.resource_type === "asset" && r.resource_id ? titles.get(r.resource_id) : undefined) ??
          (typeof meta.name === "string" ? meta.name : typeof meta.email === "string" ? meta.email : null);
        return {
          id: r.id,
          actorName: r.actor_id ? (names.get(r.actor_id) ?? "Alguien") : "Sistema",
          action: r.action,
          detail: detail ?? null,
          createdAt: r.created_at,
        };
      }),
      nextCursor: rows.length > ACTIVITY_PAGE && last ? `${last.created_at}|${last.id}` : null,
    });
  });
}

// ---------------------------------------------------------------------------
// Papelera
// ---------------------------------------------------------------------------

export type TrashItem = {
  id: string;
  kind: AssetCard["kind"];
  title: string;
  deletedAt: string;
  sizeBytes: number;
  canRestore: boolean;
  canPurge: boolean;
};

export async function listTrash(artistId: string): Promise<ActionResult<TrashItem[]>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!isUuid(artistId)) return fail(GENERIC_ERROR);
    // En la papelera can_access no aplica (está borrado): se exige poder editar en el artista (rol + alcance)
    if (!(await can(actor.id, "edit", { type: "artist", id: artistId }))) throw new ForbiddenError();

    const { data } = await createAdminClient()
      .from("assets")
      .select("id, kind, title, original_filename, deleted_at, size_bytes")
      .eq("artist_id", artistId)
      .eq("space", "workspace")
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(200);
    const rows = (data ?? []) as { id: string; kind: AssetCard["kind"]; title: string | null; original_filename: string; deleted_at: string; size_bytes: number | null }[];

    const canDeleteContainer = await can(actor.id, "delete", { type: "artist", id: artistId });
    const perms = new Map<string, { edit: boolean; del: boolean }>();
    for (const kind of new Set(rows.map((r) => r.kind))) {
      const area = AREA_OF_CLASS[kind === "other" ? "document" : kind];
      perms.set(kind, {
        edit: await userHasPermission(actor.id, `${area}.edit`),
        del: canDeleteContainer && (await userHasPermission(actor.id, `${area}.delete`)),
      });
    }
    return ok<TrashItem[]>(
      undefined,
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title || r.original_filename,
        deletedAt: r.deleted_at,
        sizeBytes: r.size_bytes ?? 0,
        canRestore: perms.get(r.kind)?.edit ?? false,
        canPurge: perms.get(r.kind)?.del ?? false,
      })),
    );
  });
}

// ---------------------------------------------------------------------------
// Acciones en lote (cada elemento comprueba SU permiso)
// ---------------------------------------------------------------------------

export type BatchResult = { done: number; failed: { id: string; message: string }[] };

function parseIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BATCH) return null;
  const ids = [...new Set(raw)];
  return ids.every((id) => isUuid(id)) ? (ids as string[]) : null;
}

async function runBatch(
  ids: string[],
  op: (id: string) => Promise<ActionResult>,
): Promise<ActionResult<BatchResult>> {
  const result: BatchResult = { done: 0, failed: [] };
  for (const id of ids) {
    try {
      const r = await op(id);
      if (r.ok) result.done++;
      else result.failed.push({ id, message: r.message });
    } catch (error) {
      if (error instanceof ForbiddenError) result.failed.push({ id, message: "Sin permiso." });
      else throw error;
    }
  }
  const message =
    result.failed.length === 0
      ? `${result.done} ${result.done === 1 ? "elemento" : "elementos"}.`
      : `${result.done} hechos, ${result.failed.length} sin cambios (permiso o estado).`;
  return ok<BatchResult>(message, result);
}

export type BulkAction =
  | { type: "publish" | "unpublish" | "trash"; ids: string[] }
  | { type: "move"; ids: string[]; artistId: string | null; folderId: string | null }
  | { type: "session-move"; ids: string[]; sessionId: string | null; folderId: string | null };

export async function bulkAssets(raw: unknown): Promise<ActionResult<BatchResult>> {
  return runAction(async () => {
    const actor = await requireActor();
    if (!raw || typeof raw !== "object") return fail(GENERIC_ERROR);
    const input = raw as Partial<BulkAction> & { ids?: unknown };
    const ids = parseIds(input.ids);
    if (!ids) return fail(`Elige entre 1 y ${MAX_BATCH} elementos.`);

    switch (input.type) {
      case "publish":
      case "unpublish": {
        const result = await runBatch(ids, async (id) =>
          setVisibilityOp(actor, await loadAssetRow(id), input.type === "publish" ? "published" : "private"),
        );
        // Un solo aviso agrupado por artista y sesión (nunca uno por archivo)
        if (input.type === "publish" && result.ok && result.data) {
          const failed = new Set(result.data.failed.map((f) => f.id));
          const published = ids.filter((id) => !failed.has(id));
          after(() => void notifyPublished(actor, published));
        }
        return result;
      }
      case "trash":
        return runBatch(ids, async (id) => trashAssetOp(actor, await loadAssetRow(id)));
      case "move": {
        const move = input as Extract<BulkAction, { type: "move" }>;
        return runBatch(ids, async (id) =>
          moveAssetOp(actor, await loadAssetRow(id), { artistId: move.artistId ?? null, folderId: move.folderId ?? null }),
        );
      }
      case "session-move": {
        const move = input as Extract<BulkAction, { type: "session-move" }>;
        return runBatch(ids, async (id) =>
          moveToSessionOp(actor, await loadAssetRow(id), { sessionId: move.sessionId ?? null, folderId: move.folderId ?? null }),
        );
      }
      default:
        return fail(GENERIC_ERROR);
    }
  });
}

export async function restoreAssets(rawIds: unknown): Promise<ActionResult<BatchResult>> {
  return runAction(async () => {
    const actor = await requireActor();
    const ids = parseIds(rawIds);
    if (!ids) return fail(`Elige entre 1 y ${MAX_BATCH} elementos.`);
    return runBatch(ids, (id) => restoreAssetOp(actor, id));
  });
}

export async function purgeAssets(rawIds: unknown): Promise<ActionResult<BatchResult>> {
  return runAction(async () => {
    const actor = await requireActor();
    const ids = parseIds(rawIds);
    if (!ids) return fail(`Elige entre 1 y ${MAX_BATCH} elementos.`);
    return runBatch(ids, (id) => purgeAssetOp(actor, id));
  });
}
