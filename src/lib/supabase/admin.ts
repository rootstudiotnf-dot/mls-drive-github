import "server-only";

import { createClient } from "@supabase/supabase-js";
import { getServiceRoleKey, getSupabaseUrl } from "@/lib/env";

/**
 * Cliente con SERVICE ROLE: salta RLS. Reglas:
 *  - Solo se importa desde código de servidor (Server Actions, Route Handlers, lib/auth).
 *    `server-only` hace fallar la compilación si algún componente de cliente lo importa.
 *  - Úsalo únicamente DESPUÉS de comprobar sesión, estado 'active' y rol del usuario que actúa.
 *  - Nunca registres sus claves ni las pases al navegador.
 */
export function createAdminClient() {
  return createClient(getSupabaseUrl(), getServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
