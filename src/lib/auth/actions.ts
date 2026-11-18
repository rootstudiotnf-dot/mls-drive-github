"use server";

import { notifyInvitationAccepted } from "@/lib/notifications/hooks";
import { redirect } from "next/navigation";
import { allowLogin, allowMagicLink } from "@/lib/auth/rate-limit";
import { getSiteUrl } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  parseEmail,
  parseName,
  parsePassword,
} from "@/lib/validation";

/** `values`: campos NO secretos que se devuelven para que el formulario no se vacíe al fallar. */
export type FormState = {
  ok: boolean;
  message: string;
  values?: { email?: string; name?: string };
} | null;

const fail = (message: string, values?: { email?: string; name?: string }): FormState => ({
  ok: false,
  message,
  values,
});

/** Mismo mensaje para cualquier fallo de acceso: no revela si el correo existe. */
const LOGIN_ERROR = "Correo o contraseña incorrectos.";
const TOO_MANY = "Demasiados intentos. Espera unos minutos y vuelve a probar.";

export async function signInWithPassword(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const typed = formData.get("email");
  const keep = { email: typeof typed === "string" ? typed.slice(0, 254) : "" };
  const email = parseEmail(typed);
  const password = formData.get("password");
  if (!email || typeof password !== "string" || password.length === 0 || password.length > 1024) {
    return fail(LOGIN_ERROR, keep);
  }

  if (!(await allowLogin(email))) return fail(TOO_MANY, keep);

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return fail(LOGIN_ERROR, keep);

  // El proxy decide el destino (inicio, o /invitacion si aún no ha aceptado).
  redirect("/");
}

export async function sendMagicLink(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const typed = formData.get("email");
  const email = parseEmail(typed);
  if (!email) {
    return fail("Escribe un correo válido.", {
      email: typeof typed === "string" ? typed.slice(0, 254) : "",
    });
  }

  // Sin cupo no se envía nada, pero la respuesta es la de siempre (no revela si la cuenta existe)
  const response: FormState = { ok: true, message: "Si el correo tiene una cuenta, recibirás un enlace para entrar en unos minutos." };
  if (!(await allowMagicLink(email))) return response;

  const supabase = await createClient();
  // shouldCreateUser:false → no se crea ninguna cuenta. El resultado se ignora a propósito
  // y la respuesta es siempre la misma, exista o no la cuenta.
  await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${getSiteUrl()}/auth/callback` },
  });

  return response;
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut(); // alcance global: invalida la sesión en Supabase
  redirect("/login");
}

/**
 * Cierra el alta de un invitado: nombre + contraseña. Orden pensado para que un fallo
 * a mitad no deje la cuenta utilizable:
 *  1) comprueba sesión e invitación pendiente y vigente (RPC con RLS: solo ve la suya)
 *  2) fija nombre y contraseña con la sesión del propio invitado
 *  3) "reclama" la invitación de forma atómica (un solo uso)
 *  4) activa el perfil
 */
export async function acceptInvitation(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const typedName = formData.get("name");
  const keep = { name: typeof typedName === "string" ? typedName.slice(0, 80) : "" };
  const name = parseName(typedName);
  if (!name) return fail("Escribe tu nombre (entre 2 y 80 caracteres).", keep);

  const password = parsePassword(formData.get("password"));
  if (!password) {
    return fail(
      `La contraseña debe tener entre ${PASSWORD_MIN} y ${PASSWORD_MAX} caracteres.`,
      keep,
    );
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return fail("Tu enlace ha caducado. Pide una nueva invitación al administrador.");

  const { data: pending } = await supabase.rpc("my_pending_invitation");
  const invitation = Array.isArray(pending) ? (pending[0] as { id: string; expires_at: string } | undefined) : undefined;
  if (!invitation || new Date(invitation.expires_at).getTime() <= Date.now()) {
    return fail("Esta invitación ha caducado o ya no es válida. Pide una nueva al administrador.");
  }

  const { error: updateError } = await supabase.auth.updateUser({
    password,
    data: { full_name: name },
  });
  if (updateError) {
    return fail("No se pudo guardar la contraseña. Prueba con otra más larga o distinta.");
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: claimed, error: claimError } = await admin
    .from("invitations")
    .update({ status: "accepted", accepted_at: nowIso })
    .eq("id", invitation.id)
    .eq("status", "pending")
    .gt("expires_at", nowIso)
    .select("id");
  if (claimError || !claimed || claimed.length !== 1) {
    return fail("Esta invitación ya no es válida. Pide una nueva al administrador.");
  }

  const { error: profileError } = await admin
    .from("profiles")
    .update({ full_name: name, status: "active" })
    .eq("id", user.id);
  if (profileError) {
    // Se devuelve la invitación a 'pending' para que pueda reintentarse.
    await admin
      .from("invitations")
      .update({ status: "pending", accepted_at: null })
      .eq("id", invitation.id);
    return fail("No se pudo completar el alta. Inténtalo de nuevo.");
  }

  // Aviso a quien envió la invitación (nunca bloquea el alta)
  await notifyInvitationAccepted(invitation.id, { id: user.id, name });
  redirect("/");
}
