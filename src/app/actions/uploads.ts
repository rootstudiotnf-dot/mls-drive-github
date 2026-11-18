"use server";

import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { getMaxUploadBytes, getPartSizeBytes } from "@/lib/env";
import { getActor, type Actor } from "@/lib/auth/session";
import { logActivity } from "@/lib/permissions/audit";
import {
  can,
  ForbiddenError,
  getEffectiveRole,
  requirePermission,
  runAction,
  userHasPermission,
} from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildDerivativeKey, buildOriginalKey, isUuid } from "@/lib/storage/keys";
import {
  abortMultipart,
  completeMultipart,
  createMultipart,
  deleteObject,
  headObject,
  listParts,
  readHead,
} from "@/lib/storage/multipart";
import { after } from "next/server";
import { signAssetUrl } from "@/lib/assets/urls";
import { createDraftBeatForAsset } from "@/lib/beats/server";
import { enqueueAndDispatch } from "@/lib/video/jobs";
import type { AssetUrlMode, AssetVariant } from "@/lib/assets/variants";
import { signPartUrl, signPutUrl } from "@/lib/storage/urls";
import {
  AREA_OF_CLASS,
  canGenerateDerivatives,
  classifyFilename,
  extensionOf,
  MULTIPART_THRESHOLD_BYTES,
  SIGNATURE_BYTES,
  signatureMatches,
  UI_TO_CLASS,
  validateUpload,
  type UiType,
} from "@/lib/storage/validate";

/**
 * Subida directa a R2 y URLs firmadas. Los archivos NUNCA pasan por el servidor: el navegador sube y
 * descarga contra R2 con URLs prefirmadas; aquí solo se autoriza, se registra y se firma.
 *
 * Reglas comunes a todas las acciones:
 *  - sesión activa + requirePermission (en servidor; nada depende del cliente)
 *  - la storage_key se lee y se usa SOLO aquí; nunca se devuelve como campo al cliente
 *    (las URLs firmadas la contienen en su ruta, pero ningún componente la recibe como dato)
 *  - las URLs firmadas no se guardan ni se registran en logs
 */

const MAX_CONCURRENT_UPLOADS = 50;
const MAX_INITS_PER_HOUR = 500;
const MAX_DERIVATIVE_BYTES = 5 * 1024 * 1024;
const DERIVATIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tipos que ve el cliente (ninguno contiene la clave del objeto)
// ---------------------------------------------------------------------------

export type InitUploadInput = {
  filename: string;
  size: number;
  type: UiType;
  artistId: string | null;
  folderId: string | null;
  /** Sesión de destino (opcional): su artista debe coincidir y la carpeta, si se da, ser de la sesión. */
  sessionId?: string | null;
  /** Usos especiales: portada de un beat (foto sin artista) o tag de voz (audio que no es un beat). */
  purpose?: "beat-cover" | "voice-tag";
  visibility: "private" | "published";
};

export type InitUploadData =
  | { assetId: string; mode: "single"; url: string; headers: Record<string, string> }
  | { assetId: string; mode: "multipart"; uploadId: string; partSize: number; totalParts: number };


// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

type OwnUpload = {
  id: string;
  kind: string;
  artist_id: string | null;
  original_filename: string;
  storage_key: string;
  upload_id: string | null;
  part_size_bytes: number | null;
  size_bytes: number;
  status: string;
  uploaded_by: string | null;
  created_at: string;
};

const OWN_COLUMNS =
  "id, kind, artist_id, original_filename, storage_key, upload_id, part_size_bytes, size_bytes, status, uploaded_by, created_at";

async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  return actor;
}

/** Carga un asset SOLO si lo subió el usuario actual (si no, 403: no se revela nada más). */
async function loadOwn(actor: Actor, assetIdRaw: unknown): Promise<OwnUpload> {
  if (!isUuid(assetIdRaw)) throw new ForbiddenError();
  const { data } = await createAdminClient()
    .from("assets")
    .select(OWN_COLUMNS)
    .eq("id", assetIdRaw)
    .eq("space", "workspace") // el Vault tiene sus propias acciones (bucket y desbloqueo propios)
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as unknown as OwnUpload | null;
  if (!row || row.uploaded_by !== actor.id) throw new ForbiddenError();
  return row;
}

function totalPartsOf(row: Pick<OwnUpload, "size_bytes" | "part_size_bytes">): number {
  return Math.ceil(row.size_bytes / (row.part_size_bytes ?? 1));
}

function cleanDisplayName(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? "";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "archivo";
}

async function markFailed(assetId: string) {
  await createAdminClient()
    .from("assets")
    .update({ status: "failed", deleted_at: new Date().toISOString(), upload_id: null })
    .eq("id", assetId);
}

// ---------------------------------------------------------------------------
// initUpload
// ---------------------------------------------------------------------------

export async function initUpload(raw: unknown): Promise<ActionResult<InitUploadData>> {
  return runAction(async () => {
    const actor = await requireActor();

    if (!raw || typeof raw !== "object") return fail("Datos no válidos.");
    const input = raw as Partial<InitUploadInput>;
    const filename = typeof input.filename === "string" ? input.filename : "";
    const size = typeof input.size === "number" ? input.size : Number.NaN;

    // 1) Validación por extensión y tamaño (nunca por el MIME del cliente)
    const validation = validateUpload({ filename, size, maxBytes: getMaxUploadBytes() });
    if (!validation.ok) return fail(validation.reason);
    const uiType = input.type;
    if (!uiType || UI_TO_CLASS[uiType] !== validation.cls) {
      return fail("El tipo elegido no coincide con el formato del archivo.");
    }
    const area = AREA_OF_CLASS[validation.cls];

    // 2) Permiso del rol (<área>.upload) → 403 si no lo tiene, aunque llame a la acción directamente
    const purpose = input.purpose === "beat-cover" || input.purpose === "voice-tag" ? input.purpose : null;
    if (purpose === "beat-cover") {
      if (validation.cls !== "photo") return fail("La portada debe ser una imagen.");
      await requirePermission("beats.edit");
    } else if (purpose === "voice-tag") {
      // Solo el owner define el tag de voz de los previews
      if (validation.cls !== "audio" || actor.roleKey !== "owner") throw new ForbiddenError();
    } else {
      await requirePermission(`${area}.upload`);
    }

    // 3) Alcance sobre el destino (regla can_access de la Fase 2: asignación o grant con can_upload)
    const artistId = input.artistId ?? null;
    const folderId = input.folderId ?? null;
    const sessionId = input.sessionId ?? null;
    if (sessionId !== null && !isUuid(sessionId)) return fail("Sesión no válida.");
    if (artistId !== null && !isUuid(artistId)) return fail("Artista no válido.");
    if (folderId !== null && !isUuid(folderId)) return fail("Carpeta no válida.");

    const admin = createAdminClient();
    if (artistId === null) {
      // Solo los beats (y sus portadas y el tag de voz) pueden ir sin artista (biblioteca aparte) y únicamente roles con alcance «todos».
      if ((validation.cls !== "audio" && purpose !== "beat-cover") || folderId !== null) return fail("Elige un artista de destino.");
      const role = await getEffectiveRole();
      if (!role || role.scope !== "all") throw new ForbiddenError();
    } else {
      let allowed = await can(actor.id, "upload", { type: "artist", id: artistId });
      if (!allowed && folderId) allowed = await can(actor.id, "upload", { type: "folder", id: folderId });
      if (!allowed && sessionId) allowed = await can(actor.id, "upload", { type: "session", id: sessionId });
      if (!allowed) throw new ForbiddenError();
    }

    // 3b) Sesión de destino: del mismo artista, y con permiso de subir a ella
    if (sessionId !== null) {
      if (artistId === null) return fail("Elige un artista de destino.");
      const { data: session } = await admin
        .from("sessions")
        .select("id, artist_id")
        .eq("id", sessionId)
        .is("deleted_at", null)
        .maybeSingle();
      const sess = session as { id: string; artist_id: string } | null;
      if (!sess || sess.artist_id !== artistId) return fail("Esa sesión no pertenece al artista elegido.");
      if (!(await can(actor.id, "upload", { type: "session", id: sessionId }))) throw new ForbiddenError();
    }

    // 4) La carpeta debe pertenecer a ese artista y ser compatible con el tipo
    if (folderId !== null) {
      const { data: folder } = await admin
        .from("folders")
        .select("id, artist_id, kind, session_id, deleted_at")
        .eq("id", folderId)
        .maybeSingle();
      const f = folder as { id: string; artist_id: string; kind: string; session_id: string | null; deleted_at: string | null } | null;
      if (!f || f.deleted_at || f.artist_id !== artistId) return fail("Esa carpeta no pertenece al artista elegido.");
      // Las carpetas de una sesión solo valen para esa sesión (y las del artista, fuera de sesiones)
      if ((f.session_id ?? null) !== sessionId) return fail("Esa carpeta no es de la sesión elegida.");
      const expected = { photo: "photos", video: "videos", audio: "files", document: "files" }[validation.cls];
      if (f.kind !== "general" && f.kind !== expected) {
        return fail("Esa carpeta es de otro tipo de contenido.");
      }
    }

    // 5) Visibilidad: publicar exige <área>.publish; si no, queda privado
    // Los vídeos siempre se suben en privado: solo se publican cuando su procesado está listo (Fase 6)
    const visibility = input.visibility === "published" && validation.cls !== "video" ? "published" : "private";
    if (visibility === "published" && !(await userHasPermission(actor.id, `${area}.publish`))) {
      return fail("No tienes permiso para publicar este tipo de contenido: se subirá como privado.");
    }

    // 6) Límites por usuario
    const [active, lastHour] = await Promise.all([
      admin
        .from("assets")
        .select("id")
        .eq("uploaded_by", actor.id)
        .eq("status", "uploading")
        .is("deleted_at", null)
        .limit(MAX_CONCURRENT_UPLOADS + 1),
      admin
        .from("activity_log")
        .select("id")
        .eq("actor_id", actor.id)
        .eq("action", "upload.init")
        .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
        .limit(MAX_INITS_PER_HOUR + 1),
    ]);
    if ((active.data?.length ?? 0) >= MAX_CONCURRENT_UPLOADS) {
      return fail("Tienes demasiadas subidas en curso. Espera a que terminen algunas.");
    }
    if ((lastHour.data?.length ?? 0) >= MAX_INITS_PER_HOUR) {
      return fail("Has alcanzado el límite de subidas por hora. Inténtalo más tarde.");
    }

    // 7) Registro del asset (la clave se calcula en servidor con nombre saneado)
    const assetId = crypto.randomUUID();
    const displayName = cleanDisplayName(filename);
    const key = buildOriginalKey(artistId, assetId, displayName);
    const title = displayName.replace(/\.[^.]*$/, "").slice(0, 120) || displayName;

    const { error: insertError } = await admin.from("assets").insert({
      id: assetId,
      kind: validation.cls,
      space: "workspace",
      artist_id: artistId,
      folder_id: folderId,
      session_id: sessionId,
      title,
      original_filename: displayName,
      storage_key: key,
      mime: validation.mime,
      size_bytes: size,
      status: "uploading",
      visibility: "private",
      downloadable: false,
      uploaded_by: actor.id,
      meta: purpose ? { purpose } : {},
    });
    if (insertError) {
      console.error("initUpload insert failed:", insertError.code ?? "");
      return fail(GENERIC_ERROR);
    }

    try {
      if (visibility === "published") {
        // Con autor registrado (trigger de publicación). Invisible mientras el asset no esté 'ready'.
        await admin.rpc("set_asset_visibility", { p_asset: assetId, p_visibility: "published", p_actor: actor.id });
      }

      await logActivity({
        actorId: actor.id,
        action: "upload.init",
        resourceType: "asset",
        resourceId: assetId,
        metadata: { size, kind: validation.cls },
      });

      // 8) Subida simple (<50 MB) o multipart
      if (size < MULTIPART_THRESHOLD_BYTES) {
        const put = await signPutUrl({ key, contentType: validation.mime });
        return ok<InitUploadData>(undefined, { assetId, mode: "single", url: put.url, headers: put.headers });
      }

      let partSize = getPartSizeBytes();
      while (Math.ceil(size / partSize) > 10_000) partSize *= 2; // límite de 10 000 partes
      const uploadId = await createMultipart({ key, contentType: validation.mime });
      const { error } = await admin
        .from("assets")
        .update({ upload_id: uploadId, part_size_bytes: partSize })
        .eq("id", assetId);
      if (error) throw new Error("no se pudo guardar el uploadId");
      return ok<InitUploadData>(undefined, {
        assetId,
        mode: "multipart",
        uploadId,
        partSize,
        totalParts: Math.ceil(size / partSize),
      });
    } catch (error) {
      console.error("initUpload failed:", error instanceof Error ? error.name : "unknown");
      await markFailed(assetId);
      return fail(GENERIC_ERROR);
    }
  });
}

// ---------------------------------------------------------------------------
// Partes y reanudación
// ---------------------------------------------------------------------------

/** Nueva URL PUT para una subida simple en curso (p. ej. tras caducar la anterior o al reanudar). */
export async function signSingleUpload(input: { assetId: string }): Promise<ActionResult<{ url: string; headers: Record<string, string> }>> {
  return runAction(async () => {
    const actor = await requireActor();
    const row = await loadOwn(actor, input?.assetId);
    if (row.status !== "uploading" || row.upload_id) return fail("Esta subida ya no se puede reanudar.");
    const mime = classifyFilename(row.original_filename)?.mime;
    if (!mime) return fail(GENERIC_ERROR);
    const put = await signPutUrl({ key: row.storage_key, contentType: mime });
    return ok(undefined, { url: put.url, headers: put.headers });
  });
}

export async function signPart(input: {
  assetId: string;
  uploadId: string;
  partNumber: number;
}): Promise<ActionResult<{ url: string }>> {
  return runAction(async () => {
    const actor = await requireActor();
    const row = await loadOwn(actor, input?.assetId);
    if (row.status !== "uploading" || !row.upload_id || row.upload_id !== input.uploadId) {
      return fail("Esta subida ya no es válida.");
    }
    const total = totalPartsOf(row);
    if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > total) {
      return fail("Parte no válida.");
    }
    const part = await signPartUrl({ key: row.storage_key, uploadId: row.upload_id, partNumber: input.partNumber });
    return ok(undefined, { url: part.url });
  });
}

export async function listUploadedParts(input: {
  assetId: string;
  uploadId: string;
}): Promise<ActionResult<{ partSize: number; totalParts: number; parts: { partNumber: number; size: number }[] }>> {
  return runAction(async () => {
    const actor = await requireActor();
    const row = await loadOwn(actor, input?.assetId);
    if (row.status !== "uploading" || !row.upload_id || row.upload_id !== input.uploadId) {
      return fail("Esta subida ya no existe.");
    }
    const parts = await listParts({ key: row.storage_key, uploadId: row.upload_id });
    return ok(undefined, {
      partSize: row.part_size_bytes ?? 0,
      totalParts: totalPartsOf(row),
      parts: parts.map((p) => ({ partNumber: p.partNumber, size: p.size })),
    });
  });
}

// ---------------------------------------------------------------------------
// completeUpload / abortUpload
// ---------------------------------------------------------------------------

export async function completeUpload(input: {
  assetId: string;
  width?: number;
  height?: number;
  /** Color medio de la foto (#rrggbb), calculado en el navegador al generar la miniatura. */
  avgColor?: string;
}): Promise<ActionResult<{ assetId: string }>> {
  return runAction(async () => {
    const actor = await requireActor();
    const row = await loadOwn(actor, input?.assetId);
    if (row.status === "ready") return ok(undefined, { assetId: row.id }); // idempotente
    if (row.status !== "uploading") return fail("Esta subida ya no es válida.");

    const admin = createAdminClient();

    // Multipart: se cierran las partes que R2 tiene (fuente de verdad), comprobando que están TODAS
    if (row.upload_id) {
      const partSize = row.part_size_bytes ?? 0;
      const total = totalPartsOf(row);
      const parts = await listParts({ key: row.storage_key, uploadId: row.upload_id });
      const complete =
        parts.length === total &&
        parts.every((p, i) => {
          const expected = i === total - 1 ? row.size_bytes - partSize * (total - 1) : partSize;
          return p.partNumber === i + 1 && p.size === expected;
        });
      if (!complete) return fail("Faltan partes por subir. Reanuda la subida.");
      await completeMultipart({
        key: row.storage_key,
        uploadId: row.upload_id,
        parts: parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      });
    }

    // HEAD: el tamaño real debe coincidir con el declarado
    const head = await headObject(row.storage_key);
    if (!head || head.size !== row.size_bytes) {
      if (head) await deleteObject(row.storage_key).catch(() => undefined);
      await markFailed(row.id);
      await logActivity({
        actorId: actor.id,
        action: "upload.failed",
        resourceType: "asset",
        resourceId: row.id,
        metadata: { reason: "size_mismatch", declared: row.size_bytes, actual: head?.size ?? null },
      });
      return fail("El archivo subido no coincide con el tamaño declarado. Vuelve a intentarlo.");
    }

    // Firma real: lo que se subió debe ser lo que dice su extensión (un .exe renombrado a .jpg no entra)
    const head8 = await readHead(row.storage_key, SIGNATURE_BYTES); // si falla, la subida sigue en curso y se reintenta (falla cerrado)
    if (!signatureMatches(extensionOf(row.original_filename), head8)) {
      await deleteObject(row.storage_key).catch(() => undefined);
      await markFailed(row.id);
      await logActivity({ actorId: actor.id, action: "upload.failed", resourceType: "asset", resourceId: row.id, metadata: { reason: "type_mismatch" } });
      return fail("El contenido del archivo no corresponde a su extensión. No se ha guardado.");
    }

    const dims: Record<string, number | string> = {};
    if (typeof input.avgColor === "string" && /^#[0-9a-f]{6}$/.test(input.avgColor) && row.kind === "photo") {
      dims.avg_color = input.avgColor;
    }
    for (const key of ["width", "height"] as const) {
      const v = input[key];
      if (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 100_000) dims[key] = v;
    }
    const { error } = await admin
      .from("assets")
      .update({ status: "ready", upload_id: null, ...dims })
      .eq("id", row.id)
      .eq("status", "uploading");
    if (error) return fail(GENERIC_ERROR);

    // Vídeo: se crea el trabajo de procesado y se avisa al servicio SIN esperar. Si no responde, queda en cola.
    if (row.kind === "video") after(() => void enqueueAndDispatch(row.id));
    // Audio «Beat» (Fase 7): se crea el beat en borrador y se genera el preview. El tag de voz no es un beat.
    if (row.kind === "audio") {
      const { data: meta } = await admin.from("assets").select("meta").eq("id", row.id).maybeSingle();
      const purpose = (meta as { meta: { purpose?: string } | null } | null)?.meta?.purpose;
      if (purpose !== "voice-tag") {
        await createDraftBeatForAsset({ assetId: row.id, filename: row.original_filename, actorId: actor.id });
        after(() => void enqueueAndDispatch(row.id, "audio"));
      }
    }

    await logActivity({
      actorId: actor.id,
      action: "upload.completed",
      resourceType: "asset",
      resourceId: row.id,
      metadata: { size: row.size_bytes, kind: row.kind },
    });
    return ok(undefined, { assetId: row.id });
  });
}

export async function abortUpload(input: { assetId: string }): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const row = await loadOwn(actor, input?.assetId);
    if (row.status === "ready") return fail("Esta subida ya terminó.");

    if (row.upload_id) await abortMultipart({ key: row.storage_key, uploadId: row.upload_id });
    await deleteObject(row.storage_key).catch(() => undefined);
    await markFailed(row.id);
    await logActivity({ actorId: actor.id, action: "upload.aborted", resourceType: "asset", resourceId: row.id });
    return ok("Subida cancelada.");
  });
}

// ---------------------------------------------------------------------------
// Derivados de fotos (miniatura y versión web, generadas en el navegador)
// ---------------------------------------------------------------------------

async function loadOwnPhotoForDerivative(actor: Actor, assetId: unknown): Promise<OwnUpload> {
  const row = await loadOwn(actor, assetId);
  if (row.kind !== "photo" || !canGenerateDerivatives(extensionOf(row.original_filename))) {
    throw new ForbiddenError();
  }
  if (Date.now() - new Date(row.created_at).getTime() > DERIVATIVE_WINDOW_MS) throw new ForbiddenError();
  return row;
}

export async function initDerivative(input: {
  assetId: string;
  type: "thumb" | "web";
  size: number;
}): Promise<ActionResult<{ url: string; headers: Record<string, string> }>> {
  return runAction(async () => {
    const actor = await requireActor();
    const row = await loadOwnPhotoForDerivative(actor, input?.assetId);
    if (input.type !== "thumb" && input.type !== "web") return fail("Tipo no válido.");
    if (!Number.isInteger(input.size) || input.size <= 0 || input.size > MAX_DERIVATIVE_BYTES) {
      return fail("Tamaño no válido.");
    }
    const key = buildDerivativeKey(row.artist_id, row.id, input.type);
    const put = await signPutUrl({ key, contentType: "image/webp" });
    return ok(undefined, { url: put.url, headers: put.headers });
  });
}

export async function completeDerivative(input: { assetId: string; type: "thumb" | "web" }): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    const row = await loadOwnPhotoForDerivative(actor, input?.assetId);
    if (input.type !== "thumb" && input.type !== "web") return fail("Tipo no válido.");

    const key = buildDerivativeKey(row.artist_id, row.id, input.type);
    const head = await headObject(key);
    if (!head || head.size <= 0 || head.size > MAX_DERIVATIVE_BYTES) {
      if (head) await deleteObject(key).catch(() => undefined);
      return fail("El derivado no se subió correctamente.");
    }
    const admin = createAdminClient();
    await admin.from("asset_derivatives").delete().eq("asset_id", row.id).eq("type", input.type);
    const { error } = await admin
      .from("asset_derivatives")
      .insert({ asset_id: row.id, type: input.type, storage_key: key, size_bytes: head.size, status: "ready" });
    if (error) return fail(GENERIC_ERROR);
    return ok();
  });
}

// ---------------------------------------------------------------------------
// getAssetUrl: ver y descargar
// ---------------------------------------------------------------------------

/**
 * URL GET prefirmada de vida corta: 5 min para ver, 2 min para descargar (con `attachment` y el nombre
 * original). Toda la lógica (can_access, estado, modo de descarga de la sesión y variante) vive en
 * `lib/assets/urls.ts`; cada descarga queda en activity_log.
 */
export async function getAssetUrl(
  assetId: string,
  variant: AssetVariant,
  mode: AssetUrlMode,
): Promise<ActionResult<{ url: string; expiresIn: number }>> {
  return runAction(async () => {
    const actor = await requireActor();
    return signAssetUrl(actor, assetId, variant, mode);
  });
}
