/** Catálogo de avisos y textos (puro: lo usan servidor, correos y la interfaz). */

export const EVENTS = ["upload_published", "comment", "mention", "link_opened", "link_expiring", "invitation_accepted", "access_request", "beat_shared"] as const;
export type NotificationEvent = (typeof EVENTS)[number];

export type Channel = "email" | "off";
export type Frequency = "instant" | "daily";
export type Preference = { channel: Channel; frequency: Frequency };

export const EVENT_LABEL: Record<NotificationEvent, { label: string; hint: string }> = {
  upload_published: { label: "Subidas publicadas", hint: "Material nuevo publicado en un artista al que tienes acceso." },
  comment: { label: "Comentarios", hint: "Alguien comenta en un archivo o beat al que tienes acceso y en el que participas." },
  mention: { label: "Menciones", hint: "Alguien te menciona con @ en un comentario." },
  link_opened: { label: "Enlace abierto", hint: "La primera vez que se abre un enlace externo que creaste." },
  link_expiring: { label: "Enlace a punto de caducar", hint: "24 horas antes de que caduque un enlace tuyo." },
  invitation_accepted: { label: "Invitación aceptada", hint: "Cuando alguien acepta una invitación que enviaste." },
  access_request: { label: "Solicitud de acceso", hint: "Cuando alguien pide acceso a un recurso que gestionas." },
  beat_shared: { label: "Beat compartido", hint: "Se comparte contigo (con tu artista) un beat publicado." },
};

/** Valores por defecto razonables: lo inmediato es lo que requiere acción; lo voluminoso, en resumen diario. */
export const DEFAULTS: Record<NotificationEvent, Preference> = {
  upload_published: { channel: "email", frequency: "daily" },
  comment: { channel: "email", frequency: "instant" },
  mention: { channel: "email", frequency: "instant" },
  link_opened: { channel: "email", frequency: "instant" },
  link_expiring: { channel: "email", frequency: "instant" },
  invitation_accepted: { channel: "email", frequency: "instant" },
  access_request: { channel: "email", frequency: "instant" },
  beat_shared: { channel: "email", frequency: "daily" },
};

export function isEvent(value: unknown): value is NotificationEvent {
  return typeof value === "string" && (EVENTS as readonly string[]).includes(value);
}

/** Datos del aviso: NADA sensible (sin URLs firmadas, claves de objeto ni nada del Vault). */
export type NotificationPayload = {
  /** Qué (nombre de la sesión, del artista, del beat, del enlace…) */
  title: string;
  /** Cuántos elementos agrupa este aviso (12 fotos nuevas…) */
  count?: number;
  /** Ruta DENTRO de la plataforma (empieza por «/»), nunca una URL firmada */
  path: string;
  artistId?: string;
  artistName?: string;
  actorName?: string;
};

const clean = (value: unknown, max: number): string =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Normaliza y limita el payload; descarta lo que no sea una ruta interna. */
export function safePayload(input: NotificationPayload): NotificationPayload {
  const path = typeof input.path === "string" && /^\/[A-Za-z0-9/_\-?=&%.#]*$/.test(input.path) && !input.path.includes("//") ? input.path.slice(0, 300) : "/";
  const count = Number.isInteger(input.count) && (input.count as number) > 0 ? Math.min(input.count as number, 100000) : undefined;
  return {
    title: clean(input.title, 120) || "—",
    path,
    ...(count ? { count } : {}),
    ...(input.artistId && /^[0-9a-f-]{36}$/i.test(input.artistId) ? { artistId: input.artistId } : {}),
    ...(input.artistName ? { artistName: clean(input.artistName, 80) } : {}),
    ...(input.actorName ? { actorName: clean(input.actorName, 80) } : {}),
  };
}

/** Frase corta del aviso (bandeja interna y correos). */
export function describe(event: NotificationEvent, p: NotificationPayload): string {
  const who = p.actorName || "Alguien";
  const n = p.count ?? 1;
  switch (event) {
    case "upload_published":
      return n === 1 ? `1 archivo nuevo en ${p.title}` : `${n} archivos nuevos en ${p.title}`;
    case "comment":
      return n <= 1 ? `${who} comentó en ${p.title}` : `${n} comentarios nuevos en ${p.title}`;
    case "mention":
      return n <= 1 ? `${who} te mencionó en ${p.title}` : `${n} menciones nuevas en ${p.title}`;
    case "link_opened":
      return `Se abrió por primera vez el enlace «${p.title}»`;
    case "link_expiring":
      return `El enlace «${p.title}» caduca en menos de 24 horas`;
    case "invitation_accepted":
      return `${who} aceptó tu invitación`;
    case "access_request":
      return `${who} pide acceso a ${p.title}`;
    case "beat_shared":
      return n <= 1 ? `Nuevo beat compartido: ${p.title}` : `${n} beats nuevos compartidos`;
  }
}

/** Suma `count` de avisos con la misma clave de grupo (para agrupar, nunca 12 avisos por 12 fotos). */
export function mergePayloads(items: NotificationPayload[]): NotificationPayload {
  const first = items[0] as NotificationPayload;
  const total = items.reduce((sum, i) => sum + (i.count ?? 1), 0);
  return { ...first, count: total };
}
