/** Tipos y utilidades puras de los beats (seguras para el cliente y para `node --test`). */

export const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
/** Tonalidades: «Am», «C#m»… (menores) y «C», «F#»… (mayores). */
export const MUSICAL_KEYS: readonly string[] = [...NOTES.map((n) => `${n}m`), ...NOTES];

export const BPM_MIN = 20;
export const BPM_MAX = 400;
export const CATALOG_PAGE_SIZE = 50;
export const BEAT_ORDERS = ["recent", "name", "bpm"] as const;
export type BeatOrder = (typeof BEAT_ORDERS)[number];
export type BeatStatus = "draft" | "published";

export type BeatRow = {
  id: string;
  assetId: string;
  title: string;
  bpm: number | null;
  key: string | null;
  genreId: string | null;
  genre: string | null;
  status: BeatStatus;
  createdOn: string;
  downloadable: boolean;
  coverAssetId: string | null;
  durationSeconds: number | null;
  previewReady: boolean;
  tags: string[];
  /** Con quién está compartido (solo lo que la persona puede ver). */
  sharedWith: { artistId: string; name: string; canDownload: boolean }[];
};

export type CatalogFilters = {
  q?: string;
  genres?: string[];
  bpmMin?: number;
  bpmMax?: number;
  keys?: string[];
  tags?: string[];
  status?: BeatStatus;
  artist?: string;
  order?: BeatOrder;
  view?: "list" | "grid";
};

/** Filtros → parámetros de la URL (así una búsqueda se puede compartir o recargar). */
export function filtersToParams(f: CatalogFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.genres?.length) p.set("genero", f.genres.join(","));
  if (f.bpmMin) p.set("bpmMin", String(f.bpmMin));
  if (f.bpmMax) p.set("bpmMax", String(f.bpmMax));
  if (f.keys?.length) p.set("tono", f.keys.join(","));
  if (f.tags?.length) p.set("etiqueta", f.tags.join(","));
  if (f.status) p.set("estado", f.status);
  if (f.artist) p.set("artista", f.artist);
  if (f.order && f.order !== "recent") p.set("orden", f.order);
  if (f.view === "grid") p.set("vista", "grid");
  return p;
}

/** Parámetros de la URL → filtros. Lo que no sea válido se descarta (el servidor vuelve a validar todo). */
export function filtersFromParams(params: Record<string, string | string[] | undefined>): CatalogFilters {
  const one = (k: string) => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v) ?? undefined;
  };
  const list = (k: string) => one(k)?.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 30);
  const num = (k: string) => {
    const n = Number(one(k));
    return Number.isInteger(n) && n >= BPM_MIN && n <= BPM_MAX ? n : undefined;
  };
  const order = BEAT_ORDERS.find((o) => o === one("orden"));
  const status = one("estado");
  return {
    q: one("q")?.trim().slice(0, 80) || undefined,
    genres: list("genero"),
    bpmMin: num("bpmMin"),
    bpmMax: num("bpmMax"),
    keys: list("tono")?.filter((k) => MUSICAL_KEYS.includes(k)),
    tags: list("etiqueta"),
    status: status === "draft" || status === "published" ? status : undefined,
    artist: one("artista"),
    order,
    view: one("vista") === "grid" ? "grid" : undefined,
  };
}

/** Tonalidad canónica a partir de lo que se escriba o venga en un nombre de archivo (Am, a minor, C#min, Bbmaj…). */
export function normalizeKey(raw: string): string | null {
  const m = /^([A-Ga-g])([#b♯♭]?)\s*(m|min|minor|maj|major|M)?$/.exec(raw.trim());
  if (!m) return null;
  const letter = (m[1] as string).toUpperCase();
  let accidental = m[2] as string;
  let note = letter;
  if (accidental === "♯") accidental = "#";
  if (accidental === "♭") accidental = "b";
  if (accidental === "b") {
    // bemol → su sostenido equivalente (Bb = A#)
    const flats: Record<string, string> = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#", Cb: "B", Fb: "E" };
    note = flats[`${letter}b`] ?? letter;
  } else {
    note = `${letter}${accidental}`;
  }
  if (!(NOTES as readonly string[]).includes(note)) return null;
  const quality = (m[3] ?? "").toLowerCase();
  const minor = quality === "m" || quality === "min" || quality === "minor";
  // «M» mayúscula y «maj/major» son mayores; sin sufijo, mayor
  const explicitMinorLower = m[3] === "m";
  return minor || explicitMinorLower ? `${note}m` : note;
}

export type FilenameSuggestion = { title: string; bpm: number | null; key: string | null };

/**
 * Sugerencias a partir del nombre del archivo: `Nombre_140_Am.wav` → «Nombre», 140, Am. Son SOLO sugerencias
 * editables (no se analiza el audio). Separadores: `_`, `-`, espacios y puntos.
 */
export function suggestFromFilename(filename: string): FilenameSuggestion {
  const base = (filename.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "");
  const tokens = base.split(/[\s_.-]+/).filter(Boolean);
  let bpm: number | null = null;
  let key: string | null = null;
  const keep: string[] = [];
  const QUALITY = /^(m|min|minor|maj|major)$/i;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    const bpmMatch = /^(\d{2,3})(?:bpm)?$/i.exec(token);
    if (bpm === null && bpmMatch && Number(bpmMatch[1]) >= 50 && Number(bpmMatch[1]) <= 250) {
      bpm = Number(bpmMatch[1]);
      if (/^bpm$/i.test(tokens[i + 1] ?? "")) i++;
      continue;
    }
    // Tonalidad: «Am», «F#m», «Bbmin» (una palabra) o «C maj» (dos); empieza en mayúscula y no es la primera palabra
    if (key === null && i > 0 && /^[A-G]/.test(token)) {
      const single = normalizeKey(token);
      const next = tokens[i + 1];
      // «D minor»: dos palabras (se prueba antes que la letra suelta)
      if (next && QUALITY.test(next) && normalizeKey(token + next)) {
        key = normalizeKey(token + next);
        i++;
        continue;
      }
      if (single && (token.length > 1 || tokens.length - 1 === i || (next !== undefined && /^\d/.test(next)))) {
        key = single;
        continue;
      }
    }
    keep.push(token);
  }
  const title = keep.join(" ").trim() || base.replace(/[_.-]+/g, " ").trim() || "Beat";
  return { title: title.slice(0, 120), bpm, key };
}

/** ¿Hay datos suficientes para publicar? (el servidor y la base de datos lo exigen también). */
export function publishProblems(beat: { title: string; bpm: number | null; key: string | null; genreId: string | null; previewReady: boolean }): string[] {
  const out: string[] = [];
  if (!beat.title.trim()) out.push("el título");
  if (beat.bpm === null) out.push("el BPM");
  if (!beat.key) out.push("la tonalidad");
  if (!beat.genreId) out.push("el género");
  if (!beat.previewReady) out.push("el preview (aún se está procesando)");
  return out;
}

export function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
