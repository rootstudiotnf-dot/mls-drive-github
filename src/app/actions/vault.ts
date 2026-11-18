"use server";

import { randomUUID } from "node:crypto";
import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { parseFlags } from "@/lib/access/grants";
import { checkRecipient } from "@/lib/access/grants";
import { getActor, type Actor } from "@/lib/auth/session";
import { getMaxUploadBytes, getPartSizeBytes, getVaultCookieSecret, isVaultConfigured } from "@/lib/env";
import { can, ForbiddenError, runAction } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { verifyPassword } from "@/lib/supabase/verify";
import { classifyFilename, extensionOf, SIGNATURE_BYTES, signatureMatches, validateUpload } from "@/lib/storage/validate";
import { isUuid } from "@/lib/storage/keys";
import { abortMultipart, completeMultipart, createMultipart, deleteObject, headObject, listParts, readHead } from "@/lib/storage/multipart";
import { signGetUrl, signPartUrl, signPutUrl } from "@/lib/storage/urls";
import { buildVaultKey, vaultBackend, VAULT_URL_TTL_SECONDS } from "@/lib/storage/vault-client";
import {
  clearUnlockCookie,
  currentAal2Session,
  hasVaultEntitlement,
  requireVaultAccess,
  setUnlockCookie,
} from "@/lib/vault/access";
import { logVault, logVaultBestEffort, VAULT_ACTIONS, type VaultAction } from "@/lib/vault/log";
import { clearFailures, LOCK_MESSAGE, readLock, recordFailure } from "@/lib/vault/attempts";

/**
 * Acciones del Vault. TODAS pasan por `requireVaultAccess` (rol + can_access + aal2 + cookie de desbloqueo) y, antes
 * de devolver contenido o una URL firmada, por `logVault` (si el registro falla, se deniega). El Vault solo se lee
 * desde aquí con el cliente de servidor: ninguna consulta normal (RLS) lo ve.
 */

const PAGE_SIZE = 50;
const DAILY_DOWNLOADS = 50;
const MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 50;
const GENERIC_UNLOCK_ERROR = "Contraseña o código incorrectos.";

async function actorOrDeny(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  return actor;
}

// ---------------------------------------------------------------------------
// Desbloqueo
// ---------------------------------------------------------------------------

export async function unlockVault(input: { password: string; code?: string }): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    if (!isVaultConfigured() || !getVaultCookieSecret() || !(await hasVaultEntitlement(actor))) throw new ForbiddenError();
    const password = typeof input?.password === "string" ? input.password : "";

    // Fuerza bruta: 5 fallos seguidos → bloqueo de 15 minutos
    const lock = await readLock(actor.id);
    if (lock.locked) return fail(`Demasiados intentos fallidos. Inténtalo de nuevo en ${lock.minutes} min.`);
    const failed = async (): Promise<ActionResult> => {
      const { locked } = await recordFailure(actor.id, lock.failures);
      await logVaultBestEffort(actor.id, "vault.open", { ok: false, locked });
      return fail(locked ? LOCK_MESSAGE : GENERIC_UNLOCK_ERROR);
    };

    // 1) Reautenticación: contraseña verificada en un cliente aparte (no toca la sesión)
    if (!(await verifyPassword(actor.email, password))) return failed();

    // 2) Verificación en dos pasos si la sesión no es aal2
    const supabase = await createClient();
    if ((await currentAal2Session()) === null) {
      const code = typeof input?.code === "string" ? input.code.replace(/\s+/g, "") : "";
      if (!/^\d{6}$/.test(code)) return fail("Introduce el código de 6 dígitos de tu aplicación de verificación.");
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const factor = factors?.totp?.[0];
      if (!factor) return fail("Activa la verificación en dos pasos para abrir el Vault.");
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
      if (error) return failed();
    }
    const sessionId = await currentAal2Session();
    if (!sessionId) throw new ForbiddenError();

    // 3) Registro obligatorio ANTES de emitir la cookie
    await logVault(actor, "vault.open", { type: "vault", id: null }, { ok: true });
    const now = Date.now();
    await setUnlockCookie({ u: actor.id, sid: sessionId, iat: now, act: now });
    await clearFailures(actor.id);
    return ok("Vault desbloqueado.");
  });
}

export async function lockVault(): Promise<ActionResult> {
  return runAction(async () => {
    await actorOrDeny();
    await clearUnlockCookie();
    return ok();
  });
}

/** Renueva la cookie por actividad (la interfaz la llama de vez en cuando mientras se usa el Vault). */
export async function touchVault(): Promise<ActionResult> {
  return runAction(async () => {
    await requireVaultAccess("view", undefined, { folderScoped: true });
    return ok();
  });
}

// ---------------------------------------------------------------------------
// Listados
// ---------------------------------------------------------------------------

export type VaultFolder = { id: string; name: string; items: number };
export type VaultLogEntry = { id: string; actorName: string; action: VaultAction; detail: string | null; createdAt: string };
export type VaultOverview = { folders: VaultFolder[]; log: VaultLogEntry[]; isOwner: boolean; canUpload: boolean };

type LogRow = { id: string; actor_id: string | null; action: string; resource_type: string | null; resource_id: string | null; metadata: Record<string, unknown> | null; created_at: string };

async function namesOf(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const { data } = await createAdminClient().from("profiles").select("id, full_name, email").in("id", unique);
  for (const p of (data ?? []) as { id: string; full_name: string | null; email: string }[]) out.set(p.id, p.full_name || p.email);
  return out;
}

function toLogEntry(r: LogRow, names: Map<string, string>): VaultLogEntry {
  const meta = r.metadata ?? {};
  return {
    id: r.id,
    actorName: r.actor_id ? (names.get(r.actor_id) ?? "Alguien") : "Sistema",
    action: r.action as VaultAction,
    detail: typeof meta.name === "string" ? meta.name : typeof meta.folder === "string" ? meta.folder : null,
    createdAt: r.created_at,
  };
}

/** Carpetas (solo las que esta persona puede ver) con su número de elementos y los últimos eventos del registro. */
export async function getVaultOverview(): Promise<ActionResult<VaultOverview>> {
  return runAction(async () => {
    const actor = await requireVaultAccess("view", undefined, { folderScoped: true });
    await logVault(actor, "vault.list", { type: "vault", id: null });
    const admin = createAdminClient();
    const { data: folderRows } = await admin.from("folders").select("id, name, sort").eq("space", "vault").is("parent_id", null).is("deleted_at", null).order("sort");
    const all = (folderRows ?? []) as { id: string; name: string }[];
    const visible = (await Promise.all(all.map(async (f) => ((await can(actor.id, "view", { type: "folder", id: f.id })) ? f : null)))).filter((f): f is { id: string; name: string } => f !== null);

    const counts = new Map<string, number>();
    if (visible.length > 0) {
      const { data: assets } = await admin.from("assets").select("folder_id").eq("space", "vault").eq("status", "ready").is("deleted_at", null).in("folder_id", visible.map((f) => f.id)).limit(20000);
      for (const a of (assets ?? []) as { folder_id: string }[]) counts.set(a.folder_id, (counts.get(a.folder_id) ?? 0) + 1);
    }

    const isOwner = actor.roleKey === "owner";
    let logQuery = admin.from("activity_log").select("id, actor_id, action, resource_type, resource_id, metadata, created_at").like("action", "vault.%");
    if (!isOwner) logQuery = logQuery.eq("actor_id", actor.id);
    const { data: logRows } = await logQuery.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(12);
    const rows = (logRows ?? []) as LogRow[];
    const names = await namesOf(rows.map((r) => r.actor_id));
    const canUpload = (await Promise.all(visible.map((f) => can(actor.id, "upload", { type: "folder", id: f.id })))).some(Boolean);
    return ok<VaultOverview>(undefined, {
      folders: visible.map((f) => ({ id: f.id, name: f.name, items: counts.get(f.id) ?? 0 })),
      log: rows.map((r) => toLogEntry(r, names)),
      isOwner,
      canUpload,
    });
  });
}

export type VaultItem = {
  id: string;
  name: string;
  kind: string;
  sizeBytes: number;
  artistName: string | null;
  uploaderName: string | null;
  createdAt: string;
  deletedAt: string | null;
  status: string;
};
export type VaultItemsPage = { folder: { id: string; name: string }; items: VaultItem[]; nextCursor: string | null; can: { upload: boolean; edit: boolean; download: boolean; delete: boolean } };

type ItemRow = { id: string; kind: string; title: string | null; original_filename: string; size_bytes: number | null; artist_id: string | null; uploaded_by: string | null; created_at: string; deleted_at: string | null; status: string };

export async function listVaultItems(input: { folderId: string; cursor?: string | null; trash?: boolean }): Promise<ActionResult<VaultItemsPage>> {
  return runAction(async () => {
    if (!isUuid(input?.folderId)) return fail(GENERIC_ERROR);
    const trash = input.trash === true;
    const actor = await requireVaultAccess(trash ? "delete" : "view", { type: "folder", id: input.folderId });
    const admin = createAdminClient();
    const { data: folder } = await admin.from("folders").select("id, name").eq("id", input.folderId).eq("space", "vault").is("deleted_at", null).maybeSingle();
    if (!folder) throw new ForbiddenError();
    await logVault(actor, "vault.list", { type: "folder", id: input.folderId }, { folder: (folder as { name: string }).name, trash });

    let query = admin.from("assets").select("id, kind, title, original_filename, size_bytes, artist_id, uploaded_by, created_at, deleted_at, status").eq("space", "vault").eq("folder_id", input.folderId);
    query = trash ? query.not("deleted_at", "is", null).eq("status", "ready") : query.is("deleted_at", null).eq("status", "ready");
    if (input.cursor) {
      const [at, id] = String(input.cursor).split("|");
      if (!at || !isUuid(id) || Number.isNaN(Date.parse(at))) return fail(GENERIC_ERROR);
      query = query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
    }
    const { data } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE_SIZE + 1);
    const rows = (data ?? []) as ItemRow[];
    const page = rows.slice(0, PAGE_SIZE);
    const names = await namesOf(page.map((r) => r.uploaded_by));
    const artistIds = [...new Set(page.map((r) => r.artist_id).filter((v): v is string => !!v))];
    const artists = new Map<string, string>();
    if (artistIds.length > 0) {
      const { data: a } = await admin.from("artists").select("id, name").in("id", artistIds);
      for (const x of (a ?? []) as { id: string; name: string }[]) artists.set(x.id, x.name);
    }
    const last = page[page.length - 1];
    const ref = { type: "folder" as const, id: input.folderId };
    const [upload, edit, download, del] = await Promise.all([can(actor.id, "upload", ref), can(actor.id, "edit", ref), can(actor.id, "download", ref), can(actor.id, "delete", ref)]);
    return ok<VaultItemsPage>(undefined, {
      folder: folder as { id: string; name: string },
      items: page.map((r) => ({
        id: r.id,
        name: r.title || r.original_filename,
        kind: r.kind,
        sizeBytes: Number(r.size_bytes ?? 0),
        artistName: r.artist_id ? (artists.get(r.artist_id) ?? null) : null,
        uploaderName: r.uploaded_by ? (names.get(r.uploaded_by) ?? null) : null,
        createdAt: r.created_at,
        deletedAt: r.deleted_at,
        status: r.status,
      })),
      nextCursor: rows.length > PAGE_SIZE && last ? `${last.created_at}|${last.id}` : null,
      can: { upload, edit, download, delete: del },
    });
  });
}

// ---------------------------------------------------------------------------
// Ver y descargar: URLs de vida muy corta (2 min / 60 s), registro obligatorio ANTES de firmar
// ---------------------------------------------------------------------------

type VaultAsset = { id: string; kind: string; status: string; storage_key: string; original_filename: string; title: string | null; folder_id: string | null; size_bytes: number | null };

async function loadVaultAsset(assetId: unknown, includeDeleted = false): Promise<VaultAsset> {
  if (!isUuid(assetId)) throw new ForbiddenError();
  let query = createAdminClient().from("assets").select("id, kind, status, storage_key, original_filename, title, folder_id, size_bytes").eq("id", assetId).eq("space", "vault");
  if (!includeDeleted) query = query.is("deleted_at", null);
  const { data } = await query.maybeSingle();
  if (!data) throw new ForbiddenError();
  return data as unknown as VaultAsset;
}

export async function getVaultUrl(input: { assetId: string; mode: "view" | "download" }): Promise<ActionResult<{ url: string; expiresIn: number }>> {
  return runAction(async () => {
    if (input?.mode !== "view" && input?.mode !== "download") return fail(GENERIC_ERROR);
    const asset = await loadVaultAsset(input.assetId);
    if (asset.status !== "ready") throw new ForbiddenError();
    const actor = await requireVaultAccess(input.mode === "view" ? "view" : "download", { type: "asset", id: asset.id });
    const admin = createAdminClient();

    if (input.mode === "download") {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count, error } = await admin.from("activity_log").select("id", { count: "exact", head: true }).eq("actor_id", actor.id).eq("action", "vault.download").gte("created_at", since);
      if (error) throw new ForbiddenError(); // sin poder contar, no se descarga
      if ((count ?? 0) >= DAILY_DOWNLOADS) return fail("Has alcanzado el límite de 50 descargas al día del Vault.");
    }

    // Registro ANTES de firmar: si falla, no hay URL
    await logVault(actor, input.mode === "view" ? "vault.preview" : "vault.download", { type: "asset", id: asset.id }, { name: asset.title || asset.original_filename, folderId: asset.folder_id });
    const signed = await signGetUrl({
      key: asset.storage_key,
      mode: input.mode,
      contentType: classifyFilename(asset.original_filename)?.mime ?? "application/octet-stream",
      filename: asset.original_filename,
      ttlSeconds: input.mode === "view" ? VAULT_URL_TTL_SECONDS.view : VAULT_URL_TTL_SECONDS.download,
      backend: vaultBackend(),
    });
    return ok(undefined, signed);
  });
}

// ---------------------------------------------------------------------------
// Subida al Vault (misma cola del navegador; las URLs apuntan al bucket del Vault)
// ---------------------------------------------------------------------------

export type VaultInitData =
  | { assetId: string; mode: "single"; url: string; headers: Record<string, string> }
  | { assetId: string; mode: "multipart"; uploadId: string; partSize: number; totalParts: number };

type OwnVault = VaultAsset & { upload_id: string | null; part_size_bytes: number | null; uploaded_by: string | null; size_bytes: number };

async function loadOwnVault(actor: Actor, assetId: unknown): Promise<OwnVault> {
  if (!isUuid(assetId)) throw new ForbiddenError();
  const { data } = await createAdminClient()
    .from("assets")
    .select("id, kind, status, storage_key, original_filename, title, folder_id, size_bytes, upload_id, part_size_bytes, uploaded_by")
    .eq("id", assetId)
    .eq("space", "vault")
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as unknown as OwnVault | null;
  if (!row || row.uploaded_by !== actor.id || !row.folder_id) throw new ForbiddenError();
  return row;
}

export async function initVaultUpload(input: { filename: string; size: number; folderId: string; artistId?: string | null }): Promise<ActionResult<VaultInitData>> {
  return runAction(async () => {
    if (!input || typeof input !== "object" || !isUuid(input.folderId)) return fail(GENERIC_ERROR);
    const validation = validateUpload({ filename: String(input.filename ?? ""), size: Number(input.size), maxBytes: getMaxUploadBytes() });
    if (!validation.ok) return fail(validation.reason);
    const actor = await requireVaultAccess("upload", { type: "folder", id: input.folderId });
    const admin = createAdminClient();

    const { data: folder } = await admin.from("folders").select("id, name").eq("id", input.folderId).eq("space", "vault").is("deleted_at", null).maybeSingle();
    if (!folder) throw new ForbiddenError();
    let artistId: string | null = null;
    if (input.artistId) {
      if (!isUuid(input.artistId)) return fail("Artista no válido.");
      const { data: artist } = await admin.from("artists").select("id").eq("id", input.artistId).is("deleted_at", null).maybeSingle();
      if (!artist) return fail("Ese artista no existe.");
      artistId = input.artistId;
    }
    const { data: active } = await admin.from("assets").select("id").eq("uploaded_by", actor.id).eq("status", "uploading").is("deleted_at", null).limit(MAX_CONCURRENT_UPLOADS + 1);
    if ((active?.length ?? 0) >= MAX_CONCURRENT_UPLOADS) return fail("Tienes demasiadas subidas en curso.");

    const assetId = randomUUID();
    const displayName = (String(input.filename).split(/[\\/]/).pop() ?? "archivo").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "archivo";
    const key = buildVaultKey(assetId, displayName);
    const size = Number(input.size);
    const { error: insertError } = await admin.from("assets").insert({
      id: assetId, kind: validation.cls, space: "vault", artist_id: artistId, folder_id: input.folderId, session_id: null,
      title: displayName.replace(/\.[^.]*$/, "").slice(0, 120) || displayName, original_filename: displayName, storage_key: key,
      mime: validation.mime, size_bytes: size, status: "uploading", visibility: "private", downloadable: false, uploaded_by: actor.id, meta: {},
    });
    if (insertError) return fail(GENERIC_ERROR);

    try {
      await logVault(actor, "vault.upload", { type: "asset", id: assetId }, { phase: "init", name: displayName, folderId: input.folderId, size });
      const backend = vaultBackend();
      if (size < MULTIPART_THRESHOLD_BYTES) {
        const put = await signPutUrl({ key, contentType: validation.mime, backend });
        return ok<VaultInitData>(undefined, { assetId, mode: "single", url: put.url, headers: put.headers });
      }
      let partSize = getPartSizeBytes();
      while (Math.ceil(size / partSize) > 10_000) partSize *= 2;
      const uploadId = await createMultipart({ key, contentType: validation.mime, backend });
      const { error } = await admin.from("assets").update({ upload_id: uploadId, part_size_bytes: partSize }).eq("id", assetId);
      if (error) throw new Error("uploadId");
      return ok<VaultInitData>(undefined, { assetId, mode: "multipart", uploadId, partSize, totalParts: Math.ceil(size / partSize) });
    } catch {
      await admin.from("assets").delete().eq("id", assetId);
      return fail(GENERIC_ERROR);
    }
  });
}

export async function signVaultSingle(input: { assetId: string }): Promise<ActionResult<{ url: string; headers: Record<string, string> }>> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    const row = await loadOwnVault(actor, input?.assetId);
    await requireVaultAccess("upload", { type: "folder", id: row.folder_id as string });
    if (row.status !== "uploading" || row.upload_id) return fail("Esta subida ya no se puede reanudar.");
    const mime = classifyFilename(row.original_filename)?.mime;
    if (!mime) return fail(GENERIC_ERROR);
    const put = await signPutUrl({ key: row.storage_key, contentType: mime, backend: vaultBackend() });
    return ok(undefined, { url: put.url, headers: put.headers });
  });
}

export async function signVaultPart(input: { assetId: string; uploadId: string; partNumber: number }): Promise<ActionResult<{ url: string }>> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    const row = await loadOwnVault(actor, input?.assetId);
    await requireVaultAccess("upload", { type: "folder", id: row.folder_id as string });
    if (row.status !== "uploading" || !row.upload_id || row.upload_id !== input.uploadId) return fail("Esta subida ya no es válida.");
    const total = Math.ceil(row.size_bytes / (row.part_size_bytes ?? 1));
    if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > total) return fail("Parte no válida.");
    const part = await signPartUrl({ key: row.storage_key, uploadId: row.upload_id, partNumber: input.partNumber, backend: vaultBackend() });
    return ok(undefined, { url: part.url });
  });
}

export async function listVaultParts(input: { assetId: string; uploadId: string }): Promise<ActionResult<{ partSize: number; totalParts: number; parts: { partNumber: number; size: number }[] }>> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    const row = await loadOwnVault(actor, input?.assetId);
    await requireVaultAccess("upload", { type: "folder", id: row.folder_id as string });
    if (row.status !== "uploading" || !row.upload_id || row.upload_id !== input.uploadId) return fail("Esta subida ya no existe.");
    const parts = await listParts({ key: row.storage_key, uploadId: row.upload_id, backend: vaultBackend() });
    return ok(undefined, { partSize: row.part_size_bytes ?? 0, totalParts: Math.ceil(row.size_bytes / (row.part_size_bytes ?? 1)), parts: parts.map((p) => ({ partNumber: p.partNumber, size: p.size })) });
  });
}

export async function completeVaultUpload(input: { assetId: string }): Promise<ActionResult<{ assetId: string }>> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    const row = await loadOwnVault(actor, input?.assetId);
    await requireVaultAccess("upload", { type: "folder", id: row.folder_id as string });
    if (row.status === "ready") return ok(undefined, { assetId: row.id });
    if (row.status !== "uploading") return fail("Esta subida ya no es válida.");
    const backend = vaultBackend();
    const admin = createAdminClient();
    if (row.upload_id) {
      const partSize = row.part_size_bytes ?? 0;
      const total = Math.ceil(row.size_bytes / partSize);
      const parts = await listParts({ key: row.storage_key, uploadId: row.upload_id, backend });
      const complete = parts.length === total && parts.every((p, i) => p.partNumber === i + 1 && p.size === (i === total - 1 ? row.size_bytes - partSize * (total - 1) : partSize));
      if (!complete) return fail("Faltan partes por subir. Reanuda la subida.");
      await completeMultipart({ key: row.storage_key, uploadId: row.upload_id, parts: parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })), backend });
    }
    const head = await headObject(row.storage_key, backend);
    if (!head || head.size !== row.size_bytes) {
      if (head) await deleteObject(row.storage_key, backend).catch(() => undefined);
      await admin.from("assets").delete().eq("id", row.id);
      return fail("El archivo subido no coincide con el tamaño declarado. Vuelve a intentarlo.");
    }
    // Firma real del archivo (igual que en el espacio normal): un ejecutable renombrado no entra ni siquiera en el Vault
    if (!signatureMatches(extensionOf(row.original_filename), await readHead(row.storage_key, SIGNATURE_BYTES, backend))) {
      await deleteObject(row.storage_key, backend).catch(() => undefined);
      await admin.from("assets").delete().eq("id", row.id);
      return fail("El contenido del archivo no corresponde a su extensión. No se ha guardado.");
    }
    await logVault(actor, "vault.upload", { type: "asset", id: row.id }, { phase: "complete", name: row.title || row.original_filename, folderId: row.folder_id, size: row.size_bytes });
    const { error } = await admin.from("assets").update({ status: "ready", upload_id: null }).eq("id", row.id).eq("status", "uploading");
    if (error) return fail(GENERIC_ERROR);
    return ok(undefined, { assetId: row.id });
  });
}

export async function abortVaultUpload(input: { assetId: string }): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    const row = await loadOwnVault(actor, input?.assetId);
    if (row.status !== "uploading") return ok();
    if (row.upload_id) await abortMultipart({ key: row.storage_key, uploadId: row.upload_id, backend: vaultBackend() });
    else await deleteObject(row.storage_key, vaultBackend()).catch(() => undefined);
    await createAdminClient().from("assets").delete().eq("id", row.id);
    return ok();
  });
}

// ---------------------------------------------------------------------------
// Papelera del Vault (30 días) y eliminación definitiva (solo owner)
// ---------------------------------------------------------------------------

export async function trashVaultItems(ids: string[]): Promise<ActionResult<{ done: number }>> {
  return runAction(async () => {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((i) => isUuid(i))) return fail(GENERIC_ERROR);
    let done = 0;
    for (const id of ids) {
      const asset = await loadVaultAsset(id);
      const actor = await requireVaultAccess("delete", { type: "asset", id });
      await logVault(actor, "vault.trash", { type: "asset", id }, { name: asset.title || asset.original_filename, folderId: asset.folder_id });
      const { error } = await createAdminClient().from("assets").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("space", "vault");
      if (!error) done++;
    }
    return ok(`${done} en la papelera.`, { done });
  });
}

export async function restoreVaultItems(ids: string[]): Promise<ActionResult<{ done: number }>> {
  return runAction(async () => {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((i) => isUuid(i))) return fail(GENERIC_ERROR);
    let done = 0;
    for (const id of ids) {
      const asset = await loadVaultAsset(id, true);
      if (!asset.folder_id) throw new ForbiddenError();
      // un asset borrado no pasa can_access: se exige el permiso sobre su carpeta
      const actor = await requireVaultAccess("delete", { type: "folder", id: asset.folder_id });
      await logVault(actor, "vault.restore", { type: "asset", id }, { name: asset.title || asset.original_filename, folderId: asset.folder_id });
      const { error } = await createAdminClient().from("assets").update({ deleted_at: null }).eq("id", id).eq("space", "vault");
      if (!error) done++;
    }
    return ok(`${done} restaurados.`, { done });
  });
}

/** Eliminación DEFINITIVA: solo el owner, desde la papelera y escribiendo ELIMINAR. */
export async function purgeVaultItem(input: { assetId: string; confirm: string }): Promise<ActionResult> {
  return runAction(async () => {
    const asset = await loadVaultAsset(input?.assetId, true);
    if (!asset.folder_id) throw new ForbiddenError();
    const actor = await requireVaultAccess("delete", { type: "folder", id: asset.folder_id });
    if (actor.roleKey !== "owner") throw new ForbiddenError();
    if (input.confirm !== "ELIMINAR") return fail("Escribe ELIMINAR para confirmar.");
    const admin = createAdminClient();
    const { data: trashed } = await admin.from("assets").select("deleted_at").eq("id", asset.id).maybeSingle();
    if (!(trashed as { deleted_at: string | null } | null)?.deleted_at) return fail("Solo se elimina definitivamente lo que está en la papelera.");
    await logVault(actor, "vault.delete", { type: "asset", id: asset.id }, { name: asset.title || asset.original_filename, folderId: asset.folder_id });
    await deleteObject(asset.storage_key, vaultBackend());
    const { error } = await admin.from("assets").delete().eq("id", asset.id);
    if (error) return fail(GENERIC_ERROR);
    return ok("Eliminado definitivamente.");
  });
}

// ---------------------------------------------------------------------------
// Concesión de acceso (solo owner; caducidad obligatoria, 90 días como máximo)
// ---------------------------------------------------------------------------

export type VaultGrantRow = { id: string; userId: string; name: string; email: string; scope: "vault" | "folder"; folderName: string | null; canView: boolean; canDownload: boolean; canUpload: boolean; canEdit: boolean; expiresAt: string; createdAt: string };

export async function listVaultGrants(): Promise<ActionResult<VaultGrantRow[]>> {
  return runAction(async () => {
    const actor = await requireVaultAccess("view");
    if (actor.roleKey !== "owner") throw new ForbiddenError();
    const admin = createAdminClient();
    const { data } = await admin.from("grants").select("id, user_id, resource_type, resource_id, can_view, can_download, can_upload, can_edit, expires_at, created_at").is("revoked_at", null).gt("expires_at", new Date().toISOString()).in("resource_type", ["vault", "folder"]).order("created_at", { ascending: false }).limit(300);
    const rows = (data ?? []) as { id: string; user_id: string; resource_type: string; resource_id: string | null; can_view: boolean; can_download: boolean; can_upload: boolean; can_edit: boolean; expires_at: string; created_at: string }[];
    const folderIds = rows.filter((r) => r.resource_type === "folder" && r.resource_id).map((r) => r.resource_id as string);
    const folders = new Map<string, string>();
    if (folderIds.length > 0) {
      const { data: f } = await admin.from("folders").select("id, name").eq("space", "vault").in("id", folderIds);
      for (const x of (f ?? []) as { id: string; name: string }[]) folders.set(x.id, x.name);
    }
    const { data: people } = await admin.from("profiles").select("id, full_name, email").in("id", [...new Set(rows.map((r) => r.user_id))]);
    const info = new Map(((people ?? []) as { id: string; full_name: string | null; email: string }[]).map((p) => [p.id, p]));
    return ok<VaultGrantRow[]>(undefined, rows
      .filter((r) => r.resource_type === "vault" || (r.resource_id && folders.has(r.resource_id)))
      .map((r) => ({
        id: r.id, userId: r.user_id, name: info.get(r.user_id)?.full_name || info.get(r.user_id)?.email || "—", email: info.get(r.user_id)?.email ?? "",
        scope: r.resource_type === "vault" ? "vault" : "folder", folderName: r.resource_id ? (folders.get(r.resource_id) ?? null) : null,
        canView: r.can_view, canDownload: r.can_download, canUpload: r.can_upload, canEdit: r.can_edit, expiresAt: r.expires_at, createdAt: r.created_at,
      })));
  });
}

export async function createVaultGrant(input: { userId: string; folderIds: string[] | null; flags: Record<string, unknown>; days: number }): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireVaultAccess("edit");
    if (actor.roleKey !== "owner") throw new ForbiddenError();
    if (!isUuid(input?.userId)) return fail(GENERIC_ERROR);
    const days = Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) return fail("La caducidad debe estar entre 1 y 90 días.");
    const flags = parseFlags(input.flags ?? {});
    if (!flags.canView && !flags.canDownload && !flags.canUpload && !flags.canEdit) return fail("Elige al menos un permiso.");
    const problem = await checkRecipient(actor.id, input.userId);
    if (problem) return fail(problem);
    const admin = createAdminClient();
    const folderIds = input.folderIds && input.folderIds.length > 0 ? input.folderIds : null;
    if (folderIds) {
      if (folderIds.length > 20 || !folderIds.every((f) => isUuid(f))) return fail(GENERIC_ERROR);
      const { data: found } = await admin.from("folders").select("id").eq("space", "vault").is("deleted_at", null).in("id", folderIds);
      if ((found?.length ?? 0) !== new Set(folderIds).size) return fail("Alguna carpeta no existe.");
    }
    const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000 - 60_000).toISOString();
    const base = { user_id: input.userId, can_view: flags.canView, can_download: flags.canDownload, can_upload: flags.canUpload, can_edit: flags.canEdit, expires_at: expires, created_by: actor.id };
    const rows: Record<string, unknown>[] = folderIds ? [...new Set(folderIds)].map((id) => ({ ...base, resource_type: "folder", resource_id: id })) : [{ ...base, resource_type: "vault", resource_id: null }];
    const { data: inserted, error } = await admin.from("grants").insert(rows).select("id");
    if (error) return fail(error.code === "23505" ? "Esa persona ya tiene acceso a eso: revócalo antes de concederlo de nuevo." : GENERIC_ERROR);
    try {
      await logVault(actor, "vault.grant", { type: "grant", id: ((inserted ?? [])[0] as { id: string } | undefined)?.id ?? null }, { userId: input.userId, scope: folderIds ? "folders" : "vault", folders: folderIds?.length ?? 0, days, flags });
    } catch (e) {
      await admin.from("grants").delete().in("id", ((inserted ?? []) as { id: string }[]).map((g) => g.id)); // sin registro, no hay concesión
      throw e;
    }
    return ok("Acceso concedido.");
  });
}

export async function revokeVaultGrant(grantId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireVaultAccess("edit");
    if (actor.roleKey !== "owner") throw new ForbiddenError();
    if (!isUuid(grantId)) return fail(GENERIC_ERROR);
    const admin = createAdminClient();
    const { data: grant } = await admin.from("grants").select("id, user_id, resource_type").eq("id", grantId).is("revoked_at", null).maybeSingle();
    const g = grant as { id: string; user_id: string; resource_type: string } | null;
    if (!g || (g.resource_type !== "vault" && g.resource_type !== "folder")) return fail("Ese acceso no existe.");
    await logVault(actor, "vault.revoke", { type: "grant", id: g.id }, { userId: g.user_id });
    const { error } = await admin.from("grants").update({ revoked_at: new Date().toISOString() }).eq("id", g.id);
    return error ? fail(GENERIC_ERROR) : ok("Acceso revocado al instante.");
  });
}

// ---------------------------------------------------------------------------
// Registro completo (solo owner): filtros, paginación y exportación a CSV
// ---------------------------------------------------------------------------

export type VaultLogFilters = { actorId?: string; action?: string; folderId?: string; from?: string; to?: string };
export type VaultLogPage = { items: VaultLogEntry[]; nextCursor: string | null; people: { id: string; name: string }[]; folders: { id: string; name: string }[] };

function buildLogQuery(filters: VaultLogFilters) {
  let query = createAdminClient().from("activity_log").select("id, actor_id, action, resource_type, resource_id, metadata, created_at").like("action", "vault.%");
  if (filters.actorId && isUuid(filters.actorId)) query = query.eq("actor_id", filters.actorId);
  if (filters.action && (VAULT_ACTIONS as readonly string[]).includes(filters.action)) query = query.eq("action", filters.action);
  if (filters.folderId && isUuid(filters.folderId)) query = query.or(`resource_id.eq.${filters.folderId},metadata->>folderId.eq.${filters.folderId}`);
  if (filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)) query = query.gte("created_at", `${filters.from}T00:00:00.000Z`);
  if (filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) query = query.lte("created_at", `${filters.to}T23:59:59.999Z`);
  return query;
}

export async function listVaultLog(input: { filters?: VaultLogFilters; cursor?: string | null }): Promise<ActionResult<VaultLogPage>> {
  return runAction(async () => {
    const actor = await requireVaultAccess("view");
    if (actor.roleKey !== "owner") throw new ForbiddenError();
    await logVault(actor, "vault.list", { type: "vault", id: null }, { log: true });
    let query = buildLogQuery(input?.filters ?? {});
    if (input?.cursor) {
      const [at, id] = String(input.cursor).split("|");
      if (!at || !isUuid(id) || Number.isNaN(Date.parse(at))) return fail(GENERIC_ERROR);
      query = query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
    }
    const { data } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE_SIZE + 1);
    const rows = (data ?? []) as LogRow[];
    const page = rows.slice(0, PAGE_SIZE);
    const names = await namesOf(page.map((r) => r.actor_id));
    const admin = createAdminClient();
    const [{ data: people }, { data: folders }] = await Promise.all([
      admin.from("profiles").select("id, full_name, email").limit(500),
      admin.from("folders").select("id, name").eq("space", "vault").is("deleted_at", null).order("sort"),
    ]);
    const last = page[page.length - 1];
    return ok<VaultLogPage>(undefined, {
      items: page.map((r) => toLogEntry(r, names)),
      nextCursor: rows.length > PAGE_SIZE && last ? `${last.created_at}|${last.id}` : null,
      people: ((people ?? []) as { id: string; full_name: string | null; email: string }[]).map((p) => ({ id: p.id, name: p.full_name || p.email })),
      folders: (folders ?? []) as { id: string; name: string }[],
    });
  });
}

const csvCell = (value: unknown): string => {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // evita fórmulas al abrirlo en una hoja de cálculo
  return `"${text.replace(/"/g, '""')}"`;
};

/** CSV del registro con los filtros actuales (hasta 20 000 filas). La propia exportación queda registrada. */
export async function exportVaultLogCsv(filters: VaultLogFilters): Promise<ActionResult<{ csv: string; rows: number }>> {
  return runAction(async () => {
    const actor = await requireVaultAccess("view");
    if (actor.roleKey !== "owner") throw new ForbiddenError();
    await logVault(actor, "vault.list", { type: "vault", id: null }, { log: true, export: true });
    const out: LogRow[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      let q = buildLogQuery(filters ?? {});
      if (cursor) {
        const [at, id] = cursor.split("|");
        q = q.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
      }
      const { data } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1000);
      const rows = (data ?? []) as LogRow[];
      out.push(...rows);
      if (rows.length < 1000) break;
      const last = rows[rows.length - 1] as LogRow;
      cursor = `${last.created_at}|${last.id}`;
    }
    const names = await namesOf(out.map((r) => r.actor_id));
    const lines = [["fecha", "persona", "acción", "recurso", "detalle"].map(csvCell).join(",")];
    for (const r of out) {
      const meta = r.metadata ?? {};
      lines.push([r.created_at, r.actor_id ? (names.get(r.actor_id) ?? r.actor_id) : "Sistema", r.action, `${r.resource_type ?? ""}:${r.resource_id ?? ""}`, typeof meta.name === "string" ? meta.name : JSON.stringify(meta)].map(csvCell).join(","));
    }
    return ok(undefined, { csv: lines.join("\r\n"), rows: out.length });
  });
}

/** Carpetas del Vault para elegir al conceder acceso (solo owner). */
export async function listVaultFolderChoices(): Promise<ActionResult<{ id: string; name: string }[]>> {
  return runAction(async () => {
    const actor = await requireVaultAccess("edit");
    if (actor.roleKey !== "owner") throw new ForbiddenError();
    const { data } = await createAdminClient().from("folders").select("id, name").eq("space", "vault").is("parent_id", null).is("deleted_at", null).order("sort");
    return ok<{ id: string; name: string }[]>(undefined, (data ?? []) as { id: string; name: string }[]);
  });
}
