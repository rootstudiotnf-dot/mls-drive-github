import "server-only";

import type { MailConfig } from "@/lib/env";

/**
 * Envío con la API HTTP de Resend mediante `fetch` (sin SDK). Reintenta con retroceso (400 ms, 1,2 s) los fallos de
 * red, 429 y 5xx; nunca lanza ni registra la clave, el destinatario ni el contenido: devuelve un error corto.
 * Cada correo lleva `List-Unsubscribe` (y one-click) además del enlace de baja del pie.
 */
export type MailMessage = { to: string; subject: string; text: string; html: string; unsubscribeUrl?: string; oneClickUrl?: string };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sendMail(config: MailConfig, message: MailMessage): Promise<{ ok: true } | { ok: false; error: string }> {
  let lastError = "error";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await wait(attempt === 1 ? 400 : 1200);
    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: config.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          // Los avisos de sistema al owner no llevan baja; los de personas, siempre
          ...(message.oneClickUrl && message.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${message.oneClickUrl}>, <${message.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return { ok: true };
      lastError = `HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 429) break; // error del cliente: reintentar no sirve
    } catch (error) {
      lastError = error instanceof Error ? error.name : "network";
    }
  }
  return { ok: false, error: lastError };
}
