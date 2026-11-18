import type { CookieOptions } from "@supabase/ssr";

/**
 * Cookies de sesión: HttpOnly (el JS del navegador nunca las lee), Secure en producción.
 * @supabase/ssr las crea por defecto sin HttpOnly porque asume un cliente de navegador;
 * aquí toda la autenticación pasa por servidor, así que las forzamos.
 */
export function sessionCookieOptions(options?: CookieOptions): CookieOptions {
  return {
    ...options,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
}
