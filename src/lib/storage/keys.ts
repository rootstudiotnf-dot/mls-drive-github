/**
 * Construcción y saneado de claves de objeto (R2). Sin dependencias: se prueba con `node --test`.
 *
 * Formato (la clave es un identificador OPACO e INMUTABLE: mover un archivo entre carpetas o artistas
 * solo cambia filas de la base de datos, nunca renombra objetos):
 *
 *   artists/{artistId}/{assetId}/original/{nombre-saneado}
 *   artists/{artistId}/{assetId}/thumb/thumb.webp      (derivados)
 *   artists/{artistId}/{assetId}/web/web.webp
 *   shared/{assetId}/original/{nombre-saneado}          (sin artista: biblioteca de beats)
 *
 * El nombre del usuario NUNCA se usa sin sanear: nada de rutas controladas por el cliente.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_FILENAME_LENGTH = 100;
const MAX_EXTENSION_LENGTH = 8;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Convierte un nombre de archivo cualquiera en uno seguro para una clave:
 *  - descarta cualquier ruta (`../../x`, `C:\\carpeta\\x`), quedándose con el último segmento
 *  - quita acentos y sustituye todo lo que no sea [A-Za-z0-9._-] (espacios, emojis, comillas…) por «-»
 *  - elimina puntos iniciales y finales y secuencias «..»
 *  - limita la longitud conservando la extensión (en minúsculas)
 * Nunca devuelve una cadena vacía («file»).
 */
export function sanitizeFilename(input: string): string {
  let name = String(input ?? "");
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  name = name.replace(/[^A-Za-z0-9._-]+/g, "-");
  name = name.replace(/\.{2,}/g, ".").replace(/-{2,}/g, "-").replace(/_{2,}/g, "_");
  name = name.replace(/[._-]+$/, "");

  // Extensión: lo que hay tras el último punto, salvo en nombres que empiezan por punto («.oculto»).
  const dot = name.lastIndexOf(".");
  let base = name;
  let ext = "";
  if (dot > 0) {
    const candidate = name.slice(dot + 1).toLowerCase();
    if (candidate.length > 0 && candidate.length <= MAX_EXTENSION_LENGTH && /^[a-z0-9]+$/.test(candidate)) {
      base = name.slice(0, dot);
      ext = candidate;
    }
  }
  base = base.replace(/^[._-]+/, "").replace(/[._-]+$/, "");

  const room = MAX_FILENAME_LENGTH - (ext ? ext.length + 1 : 0);
  base = base.slice(0, Math.max(1, room)).replace(/[._-]+$/, "");
  if (!base) base = "file";
  return ext ? `${base}.${ext}` : base;
}

export type DerivativeType = "thumb" | "web" | "proxy" | "poster" | "audio_preview";

function root(artistId: string | null, assetId: string): string {
  if (!isUuid(assetId)) throw new Error("assetId no válido");
  if (artistId === null) return `shared/${assetId}`;
  if (!isUuid(artistId)) throw new Error("artistId no válido");
  return `artists/${artistId}/${assetId}`;
}

export function buildOriginalKey(artistId: string | null, assetId: string, filename: string): string {
  return `${root(artistId, assetId)}/original/${sanitizeFilename(filename)}`;
}

const DERIVATIVE_FILE: Record<string, string> = { thumb: "thumb.webp", web: "web.webp", proxy: "proxy.mp4", poster: "poster.jpg", audio_preview: "preview.mp3" };

export function buildDerivativeKey(
  artistId: string | null,
  assetId: string,
  type: DerivativeType,
): string {
  return `${root(artistId, assetId)}/${type}/${DERIVATIVE_FILE[type] ?? `${type}.webp`}`;
}
