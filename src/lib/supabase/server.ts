import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/lib/env";
import { sessionCookieOptions } from "./cookies";

/**
 * Cliente de Supabase para servidor (Server Components, Server Actions, Route Handlers).
 * Usa la clave anónima + la sesión del usuario (cookies), así que RLS se aplica siempre.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, sessionCookieOptions(options));
          }
        } catch {
          // Llamado desde un Server Component (solo lectura de cookies): se ignora.
          // El proxy ya refresca la sesión en cada petición.
        }
      },
    },
  });
}
