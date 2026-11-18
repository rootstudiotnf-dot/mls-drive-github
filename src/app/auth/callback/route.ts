import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { getSiteUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/validation";

/**
 * Destino de los enlaces de los correos. Admite dos formas:
 *  - `?code=…`                   → intercambio PKCE (enlace por correo para entrar)
 *  - `?token_hash=…&type=invite` → verificación OTP (invitaciones; requiere la plantilla
 *                                  de correo descrita en docs/SETUP-SUPABASE.md)
 * Cada token es de un solo uso. Nunca se registran tokens ni códigos.
 */

const OTP_TYPES: readonly EmailOtpType[] = ["invite", "magiclink", "email"];

function toOtpType(value: string | null): EmailOtpType | null {
  return OTP_TYPES.find((type) => type === value) ?? null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const site = getSiteUrl();
  const fail = () => NextResponse.redirect(new URL("/login?error=link", site));

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = toOtpType(searchParams.get("type"));
  const supabase = await createClient();

  let ok = false;
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    ok = !error;
  }
  if (!ok) return fail();

  const fallback = type === "invite" ? "/invitacion" : "/";
  const next = safeNextPath(searchParams.get("next"), fallback);
  return NextResponse.redirect(new URL(next, site));
}
