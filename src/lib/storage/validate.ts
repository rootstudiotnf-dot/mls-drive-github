/**
 * Tipos permitidos: lista CERRADA por extensión. No se confía nunca en el MIME que declara el cliente;
 * el Content-Type con el que se guarda cada objeto sale de esta tabla. Sin dependencias (lo usan también
 * el cliente —para proponer el tipo— y las pruebas con `node --test`).
 */

export type UploadClass = "photo" | "video" | "audio" | "document";
/** Tipo tal y como lo elige el usuario en la interfaz. */
export type UiType = "photo" | "video" | "beat" | "file";
export type UploadArea = "photos" | "videos" | "beats" | "files";

type Entry = { cls: UploadClass; mime: string };

const ALLOWED: Record<string, Entry> = {
  // Foto
  jpg: { cls: "photo", mime: "image/jpeg" },
  jpeg: { cls: "photo", mime: "image/jpeg" },
  png: { cls: "photo", mime: "image/png" },
  webp: { cls: "photo", mime: "image/webp" },
  heic: { cls: "photo", mime: "image/heic" },
  heif: { cls: "photo", mime: "image/heif" },
  cr2: { cls: "photo", mime: "image/x-canon-cr2" },
  cr3: { cls: "photo", mime: "image/x-canon-cr3" },
  arw: { cls: "photo", mime: "image/x-sony-arw" },
  nef: { cls: "photo", mime: "image/x-nikon-nef" },
  dng: { cls: "photo", mime: "image/x-adobe-dng" },
  raf: { cls: "photo", mime: "image/x-fuji-raf" },
  // Vídeo
  mp4: { cls: "video", mime: "video/mp4" },
  mov: { cls: "video", mime: "video/quicktime" },
  m4v: { cls: "video", mime: "video/x-m4v" },
  webm: { cls: "video", mime: "video/webm" },
  mxf: { cls: "video", mime: "application/mxf" },
  // Audio
  wav: { cls: "audio", mime: "audio/wav" },
  mp3: { cls: "audio", mime: "audio/mpeg" },
  flac: { cls: "audio", mime: "audio/flac" },
  aif: { cls: "audio", mime: "audio/aiff" },
  aiff: { cls: "audio", mime: "audio/aiff" },
  m4a: { cls: "audio", mime: "audio/mp4" },
  // Archivo
  pdf: { cls: "document", mime: "application/pdf" },
  docx: { cls: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  txt: { cls: "document", mime: "text/plain; charset=utf-8" },
  zip: { cls: "document", mime: "application/zip" },
  xlsx: { cls: "document", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { cls: "document", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};

/**
 * Extensiones que se rechazan EXPLÍCITAMENTE (ejecutables, scripts y contenido activo). La lista de
 * permitidos ya las excluye; esto solo da un mensaje claro y deja documentado el propósito.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe", "dll", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "sh", "bash", "zsh", "bin", "app", "apk", "jar",
  "js", "mjs", "cjs", "ts", "py", "rb", "php", "pl", "html", "htm", "xhtml", "svg", "xml", "swf", "hta", "lnk",
]);

export const UI_TYPE_LABEL: Record<UiType, string> = {
  photo: "Foto",
  video: "Vídeo",
  beat: "Beat",
  file: "Archivo",
};

export const CLASS_TO_UI: Record<UploadClass, UiType> = {
  photo: "photo",
  video: "video",
  audio: "beat",
  document: "file",
};

export const UI_TO_CLASS: Record<UiType, UploadClass> = {
  photo: "photo",
  video: "video",
  beat: "audio",
  file: "document",
};

/** Área de permisos de cada tipo de subida (los beats son audio y cuentan como «beats»). */
export const AREA_OF_CLASS: Record<UploadClass, UploadArea> = {
  photo: "photos",
  video: "videos",
  audio: "beats",
  document: "files",
};

/** Extensión en minúsculas tras el último punto del nombre base («» si no hay). */
export function extensionOf(filename: string): string {
  const base = String(filename ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export type Classification = { ext: string; cls: UploadClass; mime: string };

/** Clasifica por extensión. Devuelve null si no está permitida. */
export function classifyFilename(filename: string): Classification | null {
  const ext = extensionOf(filename);
  const entry = Object.hasOwn(ALLOWED, ext) ? ALLOWED[ext] : undefined;
  return entry ? { ext, cls: entry.cls, mime: entry.mime } : null;
}

export type UploadValidation =
  | ({ ok: true } & Classification)
  | { ok: false; reason: string };

export function validateUpload(input: {
  filename: string;
  size: number;
  maxBytes: number;
}): UploadValidation {
  const ext = extensionOf(input.filename);
  if (!ext) return { ok: false, reason: "El archivo no tiene extensión." };
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `Los archivos .${ext} no se admiten por seguridad.` };
  }
  const classification = classifyFilename(input.filename);
  if (!classification) return { ok: false, reason: `El formato .${ext} no está permitido.` };

  if (!Number.isSafeInteger(input.size) || input.size <= 0) {
    return { ok: false, reason: "El archivo está vacío o su tamaño no es válido." };
  }
  if (input.size > input.maxBytes) {
    return { ok: false, reason: "El archivo supera el tamaño máximo permitido." };
  }
  return { ok: true, ...classification };
}

/** Formatos RAW: se intenta extraer la vista previa JPEG incrustada (mejor esfuerzo). */
export const RAW_EXTENSIONS: ReadonlySet<string> = new Set(["cr2", "cr3", "arw", "nef", "dng", "raf"]);

/**
 * Formatos de los que se intenta generar miniatura y versión web en el navegador: JPEG, PNG y WebP;
 * RAW (vista previa incrustada) y HEIC/HEIF (solo si el navegador sabe decodificarlos). Si no se puede,
 * el asset queda sin derivados y la interfaz muestra un marcador de posición.
 */
export function canGenerateDerivatives(ext: string): boolean {
  return ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp" || ext === "heic" || ext === "heif" || RAW_EXTENSIONS.has(ext);
}

/** A partir de este tamaño se usa subida multipart (partes en paralelo y reanudable). */
export const MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Firma real del archivo (los primeros bytes): la extensión la elige el cliente, el contenido no miente
// ---------------------------------------------------------------------------

/** Bytes que hay que leer del principio del objeto para comprobar su firma. */
export const SIGNATURE_BYTES = 16;

const bytesAt = (b: Uint8Array, offset: number, text: string) => text.length + offset <= b.length && [...text].every((c, i) => b[offset + i] === c.charCodeAt(0));
const startsWith = (b: Uint8Array, values: number[]) => values.length <= b.length && values.every((v, i) => b[i] === v);

/**
 * ¿Coincide el principio del archivo con lo que dice su extensión? Solo se comprueban los formatos con firma fija
 * y fiable (JPEG, PNG, WebP, PDF, ZIP y los de Office, FLAC, WAV, MP4/M4A). RAW, MOV, MP3, MXF, AIFF, HEIC y TXT no se
 * comprueban (firmas variables o sin firma). Devuelve `true` cuando no hay nada que comprobar.
 */
export function signatureMatches(ext: string, head: Uint8Array): boolean {
  switch (ext) {
    case "jpg":
    case "jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case "png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "webp":
      return bytesAt(head, 0, "RIFF") && bytesAt(head, 8, "WEBP");
    case "wav":
      return bytesAt(head, 0, "RIFF") && bytesAt(head, 8, "WAVE");
    case "pdf":
      return bytesAt(head, 0, "%PDF");
    case "zip":
    case "docx":
    case "xlsx":
    case "pptx":
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]);
    case "flac":
      return bytesAt(head, 0, "fLaC");
    case "mp4":
    case "m4v":
    case "m4a":
      return bytesAt(head, 4, "ftyp");
    default:
      return true;
  }
}
