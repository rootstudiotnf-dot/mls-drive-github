import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, EVENT_LABEL, isEvent, mergePayloads, type NotificationEvent, type NotificationPayload } from "./events.ts";

/**
 * Plantillas de correo (texto + HTML simple oscuro) y enlace de baja firmado. Puro: sin Next ni base de datos.
 *
 * Reglas: un correo NUNCA lleva archivos, URLs firmadas ni nada del Vault; solo texto y enlaces a la plataforma
 * (o al enlace externo, que es una ruta de la plataforma). El HTML usa colores literales porque un correo no
 * puede leer las variables CSS de la aplicación (es el único sitio donde se admiten).
 */

const BG = "#0b0b0c";
const PANEL = "#151517";
const LINE = "#2a2a2e";
const TEXT = "#f2f2f3";
const MUTED = "#a1a1a8";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type MailItem = { event: NotificationEvent; payload: NotificationPayload };
export type RenderedMail = { subject: string; text: string; html: string };

/** Agrupa las líneas por artista (resumen diario) y, dentro de cada uno, por tipo de aviso y destino. */
export function groupForDigest(items: MailItem[]): { artist: string; lines: { text: string; path: string }[] }[] {
  const byArtist = new Map<string, Map<string, MailItem[]>>();
  for (const item of items) {
    const artist = item.payload.artistName || "General";
    const key = `${item.event}|${item.payload.title}|${item.payload.path}`;
    const group = byArtist.get(artist) ?? new Map<string, MailItem[]>();
    group.set(key, [...(group.get(key) ?? []), item]);
    byArtist.set(artist, group);
  }
  return [...byArtist.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "es"))
    .map(([artist, groups]) => ({
      artist,
      lines: [...groups.values()].map((list) => {
        const merged = mergePayloads(list.map((l) => l.payload));
        return { text: describe((list[0] as MailItem).event, merged), path: merged.path };
      }),
    }));
}

function shell(opts: { heading: string; blocks: { title?: string; lines: { text: string; url: string }[] }[]; unsubscribeUrl: string; unsubscribeLabel: string; settingsUrl: string }): string {
  const body = opts.blocks
    .map((b) => {
      const lines = b.lines.map((l) => `<tr><td style="padding:10px 0;border-top:1px solid ${LINE};font-size:15px;line-height:1.45;color:${TEXT}"><a href="${esc(l.url)}" style="color:${TEXT};text-decoration:none">${esc(l.text)}</a></td></tr>`).join("");
      return `${b.title ? `<p style="margin:22px 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED}">${esc(b.title)}</p>` : ""}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${lines}</table>`;
    })
    .join("");
  return `<!doctype html><html lang="es"><body style="margin:0;background:${BG};padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="560" style="max-width:560px;width:100%;background:${PANEL};border:1px solid ${LINE};border-radius:12px"><tr><td style="padding:28px"><p style="margin:0 0 6px;font-size:13px;color:${MUTED}">MLS Drive</p><h1 style="margin:0;font-size:20px;line-height:1.3;color:${TEXT}">${esc(opts.heading)}</h1>${body}<p style="margin:26px 0 0;border-top:1px solid ${LINE};padding-top:14px;font-size:12px;line-height:1.5;color:${MUTED}"><a href="${esc(opts.unsubscribeUrl)}" style="color:${MUTED}">${esc(opts.unsubscribeLabel)}</a> · <a href="${esc(opts.settingsUrl)}" style="color:${MUTED}">Preferencias de avisos</a></p></td></tr></table></td></tr></table></body></html>`;
}

/** Un aviso instantáneo (ya agrupado: `items` comparten grupo). */
export function renderInstant(items: MailItem[], ctx: { siteUrl: string; unsubscribeUrl: string }): RenderedMail {
  const event = (items[0] as MailItem).event;
  const merged = mergePayloads(items.map((i) => i.payload));
  const line = describe(event, merged);
  const url = `${ctx.siteUrl}${merged.path}`;
  const subject = line.length > 90 ? `${line.slice(0, 87)}…` : line;
  const unsubscribeLabel = `Dejar de recibir avisos de «${EVENT_LABEL[event].label}»`;
  return {
    subject,
    text: `${line}\n\nAbrir: ${url}\n\n—\n${unsubscribeLabel}: ${ctx.unsubscribeUrl}\nPreferencias: ${ctx.siteUrl}/cuenta/notificaciones\n`,
    html: shell({ heading: line, blocks: [{ lines: [{ text: "Abrir en MLS Drive", url }] }], unsubscribeUrl: ctx.unsubscribeUrl, unsubscribeLabel, settingsUrl: `${ctx.siteUrl}/cuenta/notificaciones` }),
  };
}

/** Resumen diario: una sola carta con todo lo pendiente, agrupado por artista. */
export function renderDigest(items: MailItem[], ctx: { siteUrl: string; unsubscribeUrl: string; dateLabel: string }): RenderedMail {
  const groups = groupForDigest(items);
  const total = groups.reduce((n, g) => n + g.lines.length, 0);
  const subject = `Resumen del día: ${total} ${total === 1 ? "novedad" : "novedades"}`;
  const text = [
    `${subject} (${ctx.dateLabel})`,
    "",
    ...groups.flatMap((g) => [g.artist.toUpperCase(), ...g.lines.map((l) => `· ${l.text}\n  ${ctx.siteUrl}${l.path}`), ""]),
    "—",
    `Dejar de recibir este resumen: ${ctx.unsubscribeUrl}`,
    `Preferencias: ${ctx.siteUrl}/cuenta/notificaciones`,
    "",
  ].join("\n");
  return {
    subject,
    text,
    html: shell({
      heading: `${subject}`,
      blocks: groups.map((g) => ({ title: g.artist, lines: g.lines.map((l) => ({ text: l.text, url: `${ctx.siteUrl}${l.path}` })) })),
      unsubscribeUrl: ctx.unsubscribeUrl,
      unsubscribeLabel: "Dejar de recibir este resumen",
      settingsUrl: `${ctx.siteUrl}/cuenta/notificaciones`,
    }),
  };
}

// --- Enlace de baja firmado (funciona sin iniciar sesión) ---------------------------------------------------

export function signUnsubscribe(userId: string, event: NotificationEvent | "digest", key: string): string {
  const body = Buffer.from(`${userId}|${event}`).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export function verifyUnsubscribe(token: string, key: string): { userId: string; event: NotificationEvent | "digest" } | null {
  const [body, mac] = String(token ?? "").split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", key).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const [userId, event] = Buffer.from(body, "base64url").toString("utf8").split("|");
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId) || !(event === "digest" || isEvent(event))) return null;
  return { userId, event: event as NotificationEvent | "digest" };
}
