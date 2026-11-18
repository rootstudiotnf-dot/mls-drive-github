import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Registro de errores, sencillo y sin datos personales: una línea JSON estructurada en los logs del servidor
 * (Vercel las indexa) y una fila en `error_log` con SOLO el ámbito, el nombre del error y su código. Nunca el
 * mensaje, la pila, ni nada que pueda llevar datos de personas, tokens, claves o URLs firmadas.
 * Nunca lanza: registrar un error no puede provocar otro.
 */
const clean = (value: unknown, max: number) => String(value ?? "").replace(/[^\w.:-]/g, "_").slice(0, max);

export async function recordError(scope: string, error: unknown, code?: string | null): Promise<void> {
  const name = clean(error instanceof Error ? error.name : "unknown", 80) || "unknown";
  const safeScope = clean(scope, 40) || "app";
  const safeCode = code ? clean(code, 40) : null;
  console.error(JSON.stringify({ level: "error", scope: safeScope, name, code: safeCode }));
  try {
    const admin = createAdminClient();
    // Tope de 60 por minuto: una caída no puede llenar la tabla
    const { data } = await admin.rpc("rate_hit", { p_key: "error_log", p_window_seconds: 60, p_limit: 60 });
    if (data !== true) return;
    await admin.from("error_log").insert({ scope: safeScope, name, code: safeCode });
  } catch {
    // se ignora a propósito
  }
}
