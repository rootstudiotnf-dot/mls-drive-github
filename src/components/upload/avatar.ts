"use client";

import { completeDerivative, completeUpload, initDerivative, initUpload } from "@/app/actions/uploads";
import { setArtistAvatar } from "@/app/actions/artists";
import { generateDerivatives } from "./derivatives";
import { putBlob } from "./transfer";

/**
 * Sube una foto como avatar del artista (subida simple, hasta 10 MB: JPEG, PNG o WebP) con su miniatura y
 * versión web, y la deja como `avatar_asset_id`. Usa el mismo flujo seguro que el resto de subidas:
 * el navegador sube directo a R2 con una URL prefirmada.
 */
export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;

export async function uploadArtistAvatar(
  file: File,
  artistId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!/\.(jpe?g|png|webp)$/i.test(file.name)) return { ok: false, message: "El avatar debe ser JPEG, PNG o WebP." };
  if (file.size <= 0 || file.size > AVATAR_MAX_BYTES) return { ok: false, message: "El avatar no puede superar 10 MB." };

  const controller = new AbortController();
  const request = (visibility: "published" | "private") =>
    initUpload({ filename: file.name, size: file.size, type: "photo", artistId, folderId: null, visibility });

  // Publicado para que el artista también lo vea; si no hay permiso de publicar, se sube privado.
  let init = await request("published");
  if (!init.ok) init = await request("private");
  if (!init.ok || !init.data || init.data.mode !== "single") {
    return { ok: false, message: init.ok ? "No se pudo subir el avatar." : init.message };
  }
  const { assetId, url, headers } = init.data;

  try {
    await putBlob({ url, body: file, headers, signal: controller.signal });
  } catch {
    return { ok: false, message: "No se pudo subir el avatar. Inténtalo de nuevo." };
  }

  const derivs = await generateDerivatives(file);
  const done = await completeUpload({ assetId, width: derivs?.width, height: derivs?.height });
  if (!done.ok) return { ok: false, message: done.message };

  if (derivs) {
    for (const type of ["thumb", "web"] as const) {
      const blob = derivs[type];
      const prepared = await initDerivative({ assetId, type, size: blob.size });
      if (!prepared.ok || !prepared.data) continue;
      try {
        await putBlob({ url: prepared.data.url, body: blob, headers: prepared.data.headers, signal: controller.signal });
        await completeDerivative({ assetId, type });
      } catch {
        /* los derivados son opcionales */
      }
    }
  }

  const set = await setArtistAvatar(artistId, assetId);
  return set.ok ? { ok: true } : { ok: false, message: set.message };
}
