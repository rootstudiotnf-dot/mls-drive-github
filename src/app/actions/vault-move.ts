"use server";

import { after } from "next/server";
import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { getActor, type Actor } from "@/lib/auth/session";
import { getPartSizeBytes } from "@/lib/env";
import { can, ForbiddenError, runAction } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildOriginalKey, isUuid } from "@/lib/storage/keys";
import { mainBackend, type StorageBackend } from "@/lib/storage/client";
import { abortMultipart, completeMultipart, createMultipart, deleteObject, headObject, listParts } from "@/lib/storage/multipart";
import { signGetUrl, signPartUrl, signPutUrl } from "@/lib/storage/urls";
import { classifyFilename } from "@/lib/storage/validate";
import { buildVaultKey, vaultBackend } from "@/lib/storage/vault-client";
import { requireVaultAccess } from "@/lib/vault/access";
import { logVault } from "@/lib/vault/log";
import { enqueueAndDispatch } from "@/lib/video/jobs";

/**
 * Mover entre el espacio normal y el Vault. Son DOS buckets con DOS tokens distintos, así que no existe una copia
 * en el servidor de R2 a R2: la copia la hace el NAVEGADOR, parte a parte, con URLs prefirmadas de vida corta (el
 * archivo nunca pasa por el servidor). El servidor solo autoriza, firma y VERIFICA; no cambia ninguna fila ni borra
 * nada hasta comprobar la copia (tamaño y, cuando es comparable, ETag). Si algo falla a mitad, el asset queda
 * exactamente donde estaba y lo copiado a medias se descarta.
 *
 * Excepción documentada a «solo getAssetUrl firma»: la URL de LECTURA de origen es de 5 minutos, se pide por
 * parte, y solo se emite tras `requireVaultAccess` (y, si se lee del Vault, tras registrar el evento).
 */

const MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024;
const SOURCE_TTL_SECONDS = 5 * 60;
const STALE_MOVE_MS = 60 * 60 * 1000;

export type MovePlan = {
  assetId: string;
  direction: "in" | "out";
  filename: string;
  size: number;
  contentType: string;
  /** null: subida simple (un único PUT); si no, partes de `partSize` */
  partSize: number | null;
  totalParts: number;
};

type MoveRow = { asset_id: string; direction: "in" | "out"; dest_key: string; upload_id: string | null; part_size: number | null; dest_folder_id: string | null; dest_artist_id: string | null; created_by: string | null; created_at: string };
type Asset = {
  id: string; kind: string; space: "workspace" | "vault"; artist_id: string | null; folder_id: string | null; session_id: string | null;
  status: string; visibility: string; storage_key: string; original_filename: string; size_bytes: number; part_size_bytes: number | null;
  deleted_at: string | null; meta: Record<string, unknown> | null; title: string | null;
};
const ASSET_COLUMNS = "id, kind, space, artist_id, folder_id, session_id, status, visibility, storage_key, original_filename, size_bytes, part_size_bytes, deleted_at, meta, title";

async function actorOrDeny(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  return actor;
}

async function loadAsset(assetId: unknown): Promise<Asset> {
  if (!isUuid(assetId)) throw new ForbiddenError();
  const { data } = await createAdminClient().from("assets").select(ASSET_COLUMNS).eq("id", assetId).is("deleted_at", null).maybeSingle();
  if (!data) throw new ForbiddenError();
  return data as unknown as Asset;
}

async function loadMove(actor: Actor, assetId: unknown): Promise<MoveRow> {
  if (!isUuid(assetId)) throw new ForbiddenError();
  const { data } = await createAdminClient().from("vault_moves").select("*").eq("asset_id", assetId).maybeSingle();
  const row = data as MoveRow | null;
  if (!row || row.created_by !== actor.id) throw new ForbiddenError();
  return row;
}

const backendOf = (side: "source" | "dest", direction: "in" | "out"): StorageBackend => {
  const toVault = direction === "in";
  return (side === "dest") === toVault ? vaultBackend() : mainBackend();
};

async function dropPartial(move: MoveRow): Promise<void> {
  const backend = backendOf("dest", move.direction);
  try {
    if (move.upload_id) await abortMultipart({ key: move.dest_key, uploadId: move.upload_id, backend });
    else await deleteObject(move.dest_key, backend);
  } catch {
    /* si no se puede, lo recoge la purga de movimientos huérfanos */
  }
  await createAdminClient().from("vault_moves").delete().eq("asset_id", move.asset_id);
}

async function startCopy(actor: Actor, asset: Asset, direction: "in" | "out", destKey: string, destFolderId: string | null, destArtistId: string | null): Promise<MovePlan> {
  const admin = createAdminClient();
  const { data: previous } = await admin.from("vault_moves").select("*").eq("asset_id", asset.id).maybeSingle();
  if (previous) {
    const prev = previous as MoveRow;
    if (Date.now() - Date.parse(prev.created_at) < STALE_MOVE_MS && prev.created_by !== actor.id) return Promise.reject(new ForbiddenError());
    await dropPartial(prev);
  }
  const size = Number(asset.size_bytes);
  const contentType = classifyFilename(asset.original_filename)?.mime ?? "application/octet-stream";
  const backend = backendOf("dest", direction);
  let uploadId: string | null = null;
  let partSize: number | null = null;
  if (size >= MULTIPART_THRESHOLD_BYTES) {
    // Mismo tamaño de parte que el original cuando se conoce: así el ETag de la copia es comparable
    partSize = asset.part_size_bytes && asset.part_size_bytes >= 5 * 1024 * 1024 ? Number(asset.part_size_bytes) : getPartSizeBytes();
    while (Math.ceil(size / partSize) > 10_000) partSize *= 2;
    uploadId = await createMultipart({ key: destKey, contentType, backend });
  }
  const { error } = await admin.from("vault_moves").insert({ asset_id: asset.id, direction, dest_key: destKey, upload_id: uploadId, part_size: partSize, dest_folder_id: destFolderId, dest_artist_id: destArtistId, created_by: actor.id });
  if (error) {
    if (uploadId) await abortMultipart({ key: destKey, uploadId, backend });
    throw new Error("vault_moves");
  }
  return { assetId: asset.id, direction, filename: asset.original_filename, size, contentType, partSize, totalParts: partSize ? Math.ceil(size / partSize) : 1 };
}

// ---------------------------------------------------------------------------
// Mover AL Vault
// ---------------------------------------------------------------------------

export type MoveTarget = { id: string; name: string };

/** Carpetas del Vault a las que esta persona puede mover (necesita `upload` sobre la carpeta). */
export async function listMoveTargets(): Promise<ActionResult<MoveTarget[]>> {
  return runAction(async () => {
    const actor = await requireVaultAccess("upload", undefined, { folderScoped: true });
    const { data } = await createAdminClient().from("folders").select("id, name").eq("space", "vault").is("parent_id", null).is("deleted_at", null).order("sort");
    const folders = (data ?? []) as MoveTarget[];
    const allowed = await Promise.all(folders.map(async (f) => ((await can(actor.id, "upload", { type: "folder", id: f.id })) ? f : null)));
    return ok<MoveTarget[]>(undefined, allowed.filter((f): f is MoveTarget => f !== null));
  });
}

export async function beginMoveIntoVault(input: { assetId: string; folderId: string }): Promise<ActionResult<MovePlan>> {
  return runAction(async () => {
    if (!isUuid(input?.folderId)) return fail(GENERIC_ERROR);
    const asset = await loadAsset(input?.assetId);
    if (asset.space !== "workspace" || asset.status !== "ready") return fail("Ese archivo no se puede mover al Vault.");
    const actor = await requireVaultAccess("upload", { type: "folder", id: input.folderId });
    // Debe poder editarlo en el espacio normal (rol + alcance + visibilidad)
    if (!(await can(actor.id, "edit", { type: "asset", id: asset.id }))) throw new ForbiddenError();

    const admin = createAdminClient();
    const [beat, cover, avatar, sessionCover] = await Promise.all([
      admin.from("beats").select("id").or(`asset_id.eq.${asset.id},cover_asset_id.eq.${asset.id}`).is("deleted_at", null).limit(1),
      admin.from("beats").select("id").eq("cover_asset_id", asset.id).limit(1),
      admin.from("artists").select("id").eq("avatar_asset_id", asset.id).limit(1),
      admin.from("sessions").select("id").eq("cover_asset_id", asset.id).limit(1),
    ]);
    if ((beat.data?.length ?? 0) + (cover.data?.length ?? 0) + (avatar.data?.length ?? 0) + (sessionCover.data?.length ?? 0) > 0) {
      return fail("Ese archivo se usa como beat, portada o avatar: cámbialo antes de moverlo al Vault.");
    }
    const { data: folder } = await admin.from("folders").select("id").eq("id", input.folderId).eq("space", "vault").is("deleted_at", null).maybeSingle();
    if (!folder) throw new ForbiddenError();

    const plan = await startCopy(actor, asset, "in", buildVaultKey(asset.id, asset.original_filename), input.folderId, asset.artist_id);
    return ok<MovePlan>(undefined, plan);
  });
}

// ---------------------------------------------------------------------------
// Sacar DEL Vault
// ---------------------------------------------------------------------------

export type OutTarget = { artists: { id: string; name: string }[]; origin: { artistId: string | null; folderId: string | null } };

export async function getMoveOutTargets(assetId: string): Promise<ActionResult<OutTarget>> {
  return runAction(async () => {
    const asset = await loadAsset(assetId);
    if (asset.space !== "vault") throw new ForbiddenError();
    const actor = await requireVaultAccess("edit", { type: "asset", id: asset.id });
    const { data } = await createAdminClient().from("artists").select("id, name").is("deleted_at", null).order("name").limit(300);
    const artists = ((data ?? []) as { id: string; name: string }[]);
    const allowed = (await Promise.all(artists.map(async (a) => ((await can(actor.id, "edit", { type: "artist", id: a.id })) ? a : null)))).filter((a): a is { id: string; name: string } => a !== null);
    const origin = (asset.meta?.vault_origin ?? {}) as { artist_id?: string | null; folder_id?: string | null };
    return ok<OutTarget>(undefined, { artists: allowed, origin: { artistId: origin.artist_id ?? asset.artist_id, folderId: origin.folder_id ?? null } });
  });
}

export async function beginMoveOutOfVault(input: { assetId: string; artistId: string; folderId?: string | null }): Promise<ActionResult<MovePlan>> {
  return runAction(async () => {
    if (!isUuid(input?.artistId) || (input.folderId != null && !isUuid(input.folderId))) return fail(GENERIC_ERROR);
    const asset = await loadAsset(input?.assetId);
    if (asset.space !== "vault" || asset.status !== "ready") throw new ForbiddenError();
    const actor = await requireVaultAccess("edit", { type: "asset", id: asset.id });
    // Y poder editar el destino (artista y, si se elige, carpeta)
    if (!(await can(actor.id, "edit", { type: "artist", id: input.artistId }))) throw new ForbiddenError();
    const admin = createAdminClient();
    if (input.folderId) {
      const { data: f } = await admin.from("folders").select("id, artist_id, session_id").eq("id", input.folderId).eq("space", "workspace").is("deleted_at", null).maybeSingle();
      const folder = f as { artist_id: string; session_id: string | null } | null;
      if (!folder || folder.artist_id !== input.artistId || folder.session_id !== null) return fail("Esa carpeta no pertenece al artista elegido.");
      if (!(await can(actor.id, "edit", { type: "folder", id: input.folderId }))) throw new ForbiddenError();
    }
    // Leer el contenido del Vault queda registrado ANTES de emitir ninguna URL
    await logVault(actor, "vault.move_out", { type: "asset", id: asset.id }, { phase: "begin", name: asset.title || asset.original_filename });
    const plan = await startCopy(actor, asset, "out", buildOriginalKey(input.artistId, asset.id, asset.original_filename), input.folderId ?? null, input.artistId);
    return ok<MovePlan>(undefined, plan);
  });
}

// ---------------------------------------------------------------------------
// Firmado por parte, verificación y cierre (comunes a las dos direcciones)
// ---------------------------------------------------------------------------

async function requireMoveAccess(actor: Actor, move: MoveRow, asset: Asset): Promise<void> {
  // Cada paso vuelve a exigir el Vault (desbloqueo vigente, grant vigente): un acceso revocado corta el movimiento
  if (move.direction === "in") await requireVaultAccess("upload", { type: "folder", id: move.dest_folder_id as string });
  else await requireVaultAccess("edit", { type: "asset", id: asset.id });
  void actor;
}

export async function signMoveStep(input: { assetId: string; partNumber: number }): Promise<ActionResult<{ sourceUrl: string; destUrl: string; destHeaders: Record<string, string> }>> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    const move = await loadMove(actor, input?.assetId);
    const asset = await loadAsset(move.asset_id);
    await requireMoveAccess(actor, move, asset);
    const total = move.part_size ? Math.ceil(Number(asset.size_bytes) / Number(move.part_size)) : 1;
    if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > total) return fail("Parte no válida.");
    const contentType = classifyFilename(asset.original_filename)?.mime ?? "application/octet-stream";
    const source = await signGetUrl({ key: asset.storage_key, mode: "view", contentType, ttlSeconds: SOURCE_TTL_SECONDS, backend: backendOf("source", move.direction) });
    const destBackend = backendOf("dest", move.direction);
    if (move.upload_id) {
      const part = await signPartUrl({ key: move.dest_key, uploadId: move.upload_id, partNumber: input.partNumber, backend: destBackend });
      return ok(undefined, { sourceUrl: source.url, destUrl: part.url, destHeaders: {} });
    }
    const put = await signPutUrl({ key: move.dest_key, contentType, ttlSeconds: SOURCE_TTL_SECONDS, backend: destBackend });
    return ok(undefined, { sourceUrl: source.url, destUrl: put.url, destHeaders: put.headers });
  });
}

/** Un ETag es comparable si ambos son de una sola parte, o de multipart con el mismo número de partes. */
function etagsComparable(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const sa = /-(\d+)$/.exec(a)?.[1] ?? null;
  const sb = /-(\d+)$/.exec(b)?.[1] ?? null;
  return sa === sb;
}

async function queueOrphan(bucket: "main" | "vault", key: string, assetId: string): Promise<void> {
  await createAdminClient().from("storage_orphans").insert({ bucket, object_key: key, asset_id: assetId });
}

export async function completeMove(input: { assetId: string }): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    const move = await loadMove(actor, input?.assetId);
    const asset = await loadAsset(move.asset_id);
    await requireMoveAccess(actor, move, asset);
    const admin = createAdminClient();
    const destBackend = backendOf("dest", move.direction);
    const sourceBackend = backendOf("source", move.direction);
    const size = Number(asset.size_bytes);

    // 1) cerrar el multipart con las partes que de verdad tiene el destino (fuente de verdad)
    if (move.upload_id) {
      const partSize = Number(move.part_size);
      const total = Math.ceil(size / partSize);
      const parts = await listParts({ key: move.dest_key, uploadId: move.upload_id, backend: destBackend });
      const complete = parts.length === total && parts.every((p, i) => p.partNumber === i + 1 && p.size === (i === total - 1 ? size - partSize * (total - 1) : partSize));
      if (!complete) return fail("La copia está incompleta. Se descarta: el archivo sigue donde estaba.");
      await completeMultipart({ key: move.dest_key, uploadId: move.upload_id, parts: parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })), backend: destBackend });
    }

    // 2) integridad: tamaño idéntico y, si es comparable, mismo ETag que el original
    const [dest, source] = await Promise.all([headObject(move.dest_key, destBackend), headObject(asset.storage_key, sourceBackend)]);
    const sameSize = dest !== null && dest.size === size && source !== null && source.size === size;
    const sameEtag = !etagsComparable(dest?.etag ?? null, source?.etag ?? null) || dest?.etag === source?.etag;
    if (!sameSize || !sameEtag) {
      await dropPartialAfterComplete(move);
      return fail("La copia no coincide con el original. No se ha cambiado nada.");
    }

    // 3) registro obligatorio; si falla, se descarta la copia y todo queda como estaba
    try {
      await logVault(actor, move.direction === "in" ? "vault.move_in" : "vault.move_out", { type: "asset", id: asset.id }, { phase: "complete", name: asset.title || asset.original_filename, folderId: move.direction === "in" ? move.dest_folder_id : null });
    } catch (error) {
      await dropPartialAfterComplete(move);
      throw error;
    }

    // 4) cambio de filas (el trigger de la base de datos comprueba la coherencia asset ⇄ carpeta)
    const oldKey = asset.storage_key;
    const meta = { ...(asset.meta ?? {}) } as Record<string, unknown>;
    let update: Record<string, unknown>;
    if (move.direction === "in") {
      meta.vault_origin = { artist_id: asset.artist_id, folder_id: asset.folder_id, session_id: asset.session_id, visibility: asset.visibility };
      update = { space: "vault", storage_key: move.dest_key, folder_id: move.dest_folder_id, session_id: null, visibility: "private", downloadable: false, meta };
    } else {
      delete meta.vault_origin;
      update = { space: "workspace", storage_key: move.dest_key, artist_id: move.dest_artist_id, folder_id: move.dest_folder_id, session_id: null, visibility: "private", downloadable: false, meta };
    }
    const { error } = await admin.from("assets").update(update).eq("id", asset.id).eq("space", asset.space).eq("storage_key", oldKey);
    if (error) {
      await dropPartialAfterComplete(move);
      return fail("No se pudo completar el movimiento. El archivo sigue donde estaba.");
    }
    await admin.from("vault_moves").delete().eq("asset_id", asset.id);

    // 5) limpieza del origen. Al entrar en el Vault también se borran miniaturas, versiones web, proxy, póster y
    //    preview del espacio normal: el Vault no deja copias derivadas fuera de su bucket.
    const toDelete: { bucket: "main" | "vault"; key: string }[] = [{ bucket: move.direction === "in" ? "main" : "vault", key: oldKey }];
    if (move.direction === "in") {
      const { data: derivs } = await admin.from("asset_derivatives").select("storage_key").eq("asset_id", asset.id);
      for (const d of (derivs ?? []) as { storage_key: string }[]) toDelete.push({ bucket: "main", key: d.storage_key });
      await admin.from("asset_derivatives").delete().eq("asset_id", asset.id);
    }
    for (const item of toDelete) {
      try {
        await deleteObject(item.key, item.bucket === "main" ? mainBackend() : vaultBackend());
      } catch {
        await queueOrphan(item.bucket, item.key, asset.id);
      }
    }
    if (move.direction === "out" && asset.kind === "video") after(() => void enqueueAndDispatch(asset.id));
    return ok(move.direction === "in" ? "Movido al Vault." : "Sacado del Vault.");
  });
}

async function dropPartialAfterComplete(move: MoveRow): Promise<void> {
  const backend = backendOf("dest", move.direction);
  try {
    await deleteObject(move.dest_key, backend); // ya completado: se borra el objeto
  } catch {
    await createAdminClient().from("storage_orphans").insert({ bucket: move.direction === "in" ? "vault" : "main", object_key: move.dest_key, asset_id: move.asset_id });
  }
  await createAdminClient().from("vault_moves").delete().eq("asset_id", move.asset_id);
}

export async function abortMove(input: { assetId: string }): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    const move = await loadMove(actor, input?.assetId);
    await dropPartial(move);
    return ok();
  });
}
