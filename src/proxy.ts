import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, makeNonce } from "@/lib/csp";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/lib/env";
import { sessionCookieOptions } from "@/lib/supabase/cookies";

/**
 * Proxy (antes "middleware"; Next 16 renombró la convención).
 * Refresca la sesión y hace la redirección básica:
 *  - sin sesión            → /login (salvo rutas públicas)
 *  - con sesión y activa   → fuera de /login e /invitacion
 *  - con sesión, invitado  → /invitacion (hasta que cree su contraseña)
 *  - con sesión desactivada/sin perfil → se cierra la sesión y /login
 *
 * Es la primera barrera, no la única: páginas y acciones de servidor vuelven a comprobar
 * sesión, estado y rol (lib/auth/session.ts), y RLS lo comprueba en la base de datos.
 */

// /api/internal/* lo llama el servicio de procesado: no hay sesión de usuario; lo protege la firma HMAC.
// /c/* son los enlaces externos (los protege el token, no la sesión); /baja y /api/baja, la baja de avisos por correo (firmada).
const PUBLIC_PATHS = ["/login", "/invitacion", "/auth/callback", "/api/internal", "/c", "/baja", "/api/baja", "/mantenimiento"];

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Orígenes de los buckets (subidas y descargas directas con URL prefirmada): único sitio externo al que se conecta el navegador. */
function storageOrigins(): string[] {
  const origins: (string | undefined)[] = [process.env.R2_ENDPOINT, process.env.R2_VAULT_ENDPOINT];
  const account = process.env.R2_ACCOUNT_ID?.trim();
  if (account && /^[a-z0-9]+$/i.test(account)) origins.push(`https://${account}.r2.cloudflarestorage.com`);
  return origins.filter((o): o is string => Boolean(o));
}

export async function proxy(request: NextRequest) {
  // CSP con nonce por petición: Next lo lee de la cabecera de la PETICIÓN y se lo pone a sus scripts.
  const csp = buildCsp({ nonce: makeNonce(), dev: process.env.NODE_ENV !== "production", storageOrigins: storageOrigins() });
  const forward = () => {
    const headers = new Headers(request.headers);
    headers.set("content-security-policy", csp);
    return headers;
  };
  const next = () => {
    const res = NextResponse.next({ request: { headers: forward() } });
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };
  // Modo mantenimiento (MAINTENANCE_MODE=1): 503 con una página fija. Los procesos internos (cron, callbacks) siguen funcionando.
  const path = request.nextUrl.pathname;
  if (process.env.MAINTENANCE_MODE === "1" && !path.startsWith("/mantenimiento") && !path.startsWith("/api/internal")) {
    const res = NextResponse.rewrite(new URL("/mantenimiento", request.url), { request: { headers: forward() }, status: 503 });
    res.headers.set("Content-Security-Policy", csp);
    res.headers.set("Retry-After", "300");
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  let response = next();

  const supabase = createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = next();
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, sessionCookieOptions(options));
        }
      },
    },
  });

  /** Redirige conservando las cookies de sesión que haya que escribir (refresco o cierre). */
  const redirectTo = (pathname: string, search = "") => {
    const url = request.nextUrl.clone();
    url.pathname = pathname;
    url.search = search;
    const redirect = NextResponse.redirect(url);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  };

  const { pathname } = request.nextUrl;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return isPublic(pathname) ? response : redirectTo("/login");
  }

  // El callback debe poder completarse siempre (puede estar cambiando la sesión).
  if (pathname.startsWith("/auth/")) return response;

  const { data: profile } = await supabase
    .from("profiles")
    .select("status")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.status === "active") {
    return pathname === "/login" || pathname.startsWith("/invitacion")
      ? redirectTo("/")
      : response;
  }

  // Perfil 'disabled': ¿es un invitado que aún no ha creado su contraseña?
  if (profile) {
    const { data: pending } = await supabase.rpc("my_pending_invitation");
    if (Array.isArray(pending) && pending.length > 0) {
      return pathname.startsWith("/invitacion") ? response : redirectTo("/invitacion");
    }
  }

  // Cuenta desactivada, borrada o inexistente: se invalida la sesión.
  await supabase.auth.signOut();
  return pathname === "/login" ? response : redirectTo("/login", "?error=disabled");
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.svg|robots.txt).*)"],
};
