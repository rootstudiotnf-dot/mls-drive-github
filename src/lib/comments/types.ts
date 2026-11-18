/** Tipos y utilidades puras de los comentarios (seguras para el cliente). */

export const MAX_COMMENT_LENGTH = 2000;
export const MAX_COMMENTS_PER_HOUR = 30;

export type CommentItem = {
  id: string;
  parentId: string | null;
  authorName: string;
  /** El comentario es de la persona que lo está viendo (puede editarlo y borrarlo). */
  mine: boolean;
  body: string;
  /** Marca de tiempo en ms (null = comentario general o respuesta). */
  timecodeMs: number | null;
  resolved: boolean;
  createdAt: string;
  editedAt: string | null;
  /** Comentario de una persona SIN cuenta (visitante de un enlace externo) */
  external: boolean;
  /** Personas mencionadas con @ (solo las que tenían acceso al archivo) */
  mentions: { id: string; name: string }[];
};

export type CommentsData = {
  comments: CommentItem[];
  /** Cosmética: el servidor vuelve a comprobar cada acción. */
  canComment: boolean;
  canModerate: boolean;
};

export type CommentThread = CommentItem & { replies: CommentItem[] };

/** «mm:ss» o «h:mm:ss» a partir de milisegundos. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Acepta «90», «1:30» o «1:02:03» y devuelve ms (null si no es válido). */
export function parseTimecode(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some((p) => !/^\d{1,5}$/.test(p))) return null;
  const nums = parts.map(Number);
  const seconds = nums.reduce((total, n) => total * 60 + n, 0);
  return seconds * 1000;
}

/** Hilos ordenados por marca de tiempo (los generales, al final); las respuestas, por fecha. */
export function buildThreads(items: CommentItem[]): CommentThread[] {
  const replies = new Map<string, CommentItem[]>();
  for (const item of items) {
    if (item.parentId) replies.set(item.parentId, [...(replies.get(item.parentId) ?? []), item]);
  }
  return items
    .filter((c) => !c.parentId)
    .map((c) => ({ ...c, replies: (replies.get(c.id) ?? []).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)) }))
    .sort((a, b) => {
      const at = a.timecodeMs ?? Number.POSITIVE_INFINITY;
      const bt = b.timecodeMs ?? Number.POSITIVE_INFINITY;
      return at !== bt ? (at < bt ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1;
    });
}
