"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Cliente de navegador (clave anónima, RLS aplicada).
 *
 * En la Fase 1 NO se usa: la sesión vive en cookies HttpOnly y toda la autenticación y las
 * escrituras pasan por servidor, así que este cliente no puede leer la sesión. Se deja
 * preparado para fases futuras (p. ej. Realtime) y no debe usarse para saltarse las
 * acciones de servidor.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  }
  return createBrowserClient(url, anonKey);
}
