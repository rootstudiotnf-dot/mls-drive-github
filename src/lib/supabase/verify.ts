import { createClient } from "@supabase/supabase-js";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/lib/env";

/**
 * Comprueba una contraseña con una petición de autenticación en un cliente APARTE (clave anónima, sin guardar
 * sesión ni cookies): la sesión actual de la persona no se sustituye ni se toca. Se usa para volver a pedir la
 * contraseña al desbloquear el Vault. Devuelve false ante cualquier error (falla cerrado).
 */
export async function verifyPassword(email: string, password: string): Promise<boolean> {
  if (!email || !password || password.length > 1024) return false;
  try {
    const client = createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session) return false;
    // La sesión temporal creada para comprobar no se deja viva
    await client.auth.signOut({ scope: "local" }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
