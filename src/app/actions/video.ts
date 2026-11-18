"use server";

import { after } from "next/server";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { getActor } from "@/lib/auth/session";
import { logActivity } from "@/lib/permissions/audit";
import { can, ForbiddenError, runAction } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/storage/keys";
import { dispatchVideoJob, enqueueVideoJob, loadVideoStates } from "@/lib/video/jobs";
import type { VideoState } from "@/lib/video/jobs-types";

/**
 * Acciones de vídeo: reprocesar y consultar el estado de procesado. Toda acción comprueba sesión y permisos
 * en servidor (nada depende de lo que muestre el cliente).
 */

/** Reprocesa un vídeo (owner/admin: quien puede publicar sobre él). Falla si ya hay un trabajo en marcha. */
export async function reprocessVideo(assetId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await getActor();
    if (!actor) throw new ForbiddenError();
    if (!isUuid(assetId)) return fail("Vídeo no válido.");
    if (!(await can(actor.id, "publish", { type: "asset", id: assetId }))) throw new ForbiddenError();

    const admin = createAdminClient();
    const { data } = await admin.from("assets").select("id, kind, status").eq("id", assetId).eq("space", "workspace").is("deleted_at", null).maybeSingle();
    const asset = data as { id: string; kind: string; status: string } | null;
    if (!asset || asset.kind !== "video" || asset.status !== "ready") return fail("Ese archivo no es un vídeo listo.");

    const jobId = await enqueueVideoJob(asset.id);
    if (!jobId) return fail("Ya se está procesando este vídeo.");
    await logActivity({ actorId: actor.id, action: "video.reprocess", resourceType: "asset", resourceId: asset.id });
    after(() => void dispatchVideoJob(jobId));
    return ok("Reprocesando…");
  });
}

/** Estado de procesado de varios vídeos (solo de los que la persona puede ver; el resto se omite). */
export async function getVideoStates(assetIds: string[]): Promise<ActionResult<Record<string, VideoState>>> {
  return runAction(async () => {
    const actor = await getActor();
    if (!actor) throw new ForbiddenError();
    const ids = Array.isArray(assetIds) ? [...new Set(assetIds.filter((id) => isUuid(id)))].slice(0, 100) : [];
    const visible: string[] = [];
    for (let i = 0; i < ids.length; i += 25) {
      const batch = ids.slice(i, i + 25);
      const allowed = await Promise.all(batch.map((id) => can(actor.id, "view", { type: "asset", id })));
      batch.forEach((id, k) => allowed[k] && visible.push(id));
    }
    const states = await loadVideoStates(visible);
    return ok<Record<string, VideoState>>(undefined, Object.fromEntries(states));
  });
}
