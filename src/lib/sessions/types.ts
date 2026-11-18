/** Tipos compartidos de las sesiones (seguros para el cliente: ninguno lleva `storage_key`). */
import type { DownloadMode } from "@/lib/assets/variants";

export type SessionRecord = {
  id: string;
  name: string;
  date: string | null;
  description: string | null;
  artistId: string;
  downloadMode: DownloadMode;
  coverAssetId: string | null;
  status: "active" | "archived";
};

export type SessionPhoto = {
  id: string;
  title: string;
  filename: string;
  folderId: string | null;
  visibility: "private" | "published";
  downloadable: boolean;
  /** Dimensiones (para reservar la altura antes de cargar). null si no se conocen (RAW sin vista previa, etc.). */
  width: number | null;
  height: number | null;
  /** Color medio «#rrggbb»: marcador mientras carga la miniatura. */
  avgColor: string | null;
  sizeBytes: number;
  createdAt: string;
  sortIndex: number | null;
};

export type SessionFolder = { id: string; name: string; photos: number };

export type SessionMaterial = {
  id: string;
  title: string;
  filename: string;
  kind: string;
  sizeBytes: number;
  visibility: "private" | "published";
  createdAt: string;
};

export type FavoriteEntry = {
  assetId: string;
  title: string;
  filename: string;
  by: { name: string; at: string }[];
};

export type SortMode = "manual" | "name" | "date";

/** Ordena fotos ya cargadas (el orden manual usa sort_index y, sin él, la fecha de subida). */
export function sortPhotos(photos: SessionPhoto[], mode: SortMode): SessionPhoto[] {
  const copy = [...photos];
  if (mode === "name") return copy.sort((a, b) => a.filename.localeCompare(b.filename, "es", { numeric: true, sensitivity: "base" }));
  if (mode === "date") return copy.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  return copy.sort((a, b) => {
    const ai = a.sortIndex ?? Number.POSITIVE_INFINITY;
    const bi = b.sortIndex ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai < bi ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
  });
}
