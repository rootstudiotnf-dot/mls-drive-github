import "server-only";

import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { requireActor, type Actor } from "@/lib/auth/session";
import { getEffectiveRole } from "@/lib/permissions/server";
import { hasAdminShell } from "@/lib/permissions/portal";
import type { RoleDef } from "@/lib/permissions/power";
import { loadArtistBySlug, type ArtistRecord } from "./data";

/**
 * Contexto de una página del portal de un artista. Cada página lo llama ella misma (los layouts no se
 * re-ejecutan en cada navegación). Sin acceso al artista es un 404 idéntico al de un artista que no existe:
 * nadie descubre qué espacios hay ni de quién son.
 */
export type PortalContext = {
  actor: Actor;
  role: RoleDef;
  artist: ArtistRecord;
  /** Qué áreas puede ver esta persona (por su rol). */
  areas: { photos: boolean; videos: boolean; files: boolean; beats: boolean };
};

export const getPortalContext = cache(async (slug: string): Promise<PortalContext> => {
  const actor = await requireActor();
  const role = await getEffectiveRole();
  if (!role) notFound();
  // El personal de administración trabaja desde /artistas; el portal es la vista de artistas y colaboradores
  if (hasAdminShell(role.permissions)) redirect(`/artistas/${encodeURIComponent(slug)}`);

  const artist = await loadArtistBySlug(slug); // RLS: sin acceso → null
  if (!artist || artist.status === "archived") notFound();

  const areas = {
    photos: role.permissions.has("photos.view"),
    videos: role.permissions.has("videos.view"),
    files: role.permissions.has("files.view"),
    beats: role.permissions.has("beats.view"),
  };
  return { actor, role, artist, areas };
});
