/**
 * Crea la PRIMERA cuenta owner (se ejecuta una sola vez, al montar el proyecto).
 *
 *   npm run create-owner
 *
 * Lee de .env.local: OWNER_EMAIL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y
 * NEXT_PUBLIC_SITE_URL. Registra una invitación con rol owner y envía el correo de invitación;
 * la cuenta se activa cuando abres el enlace y creas tu contraseña en /invitacion.
 *
 * - Si ya existe un owner activo, no hace nada.
 * - Si quedó una invitación de owner pendiente (p. ej. caducó el enlace), la renueva y la reenvía.
 * - Usa el service role: ejecútalo solo en tu máquina y no compartas su salida.
 * - No imprime claves ni enlaces.
 *
 * Requiere Node 22.18+ (ejecuta TypeScript directamente); este archivo solo usa sintaxis borrable.
 */
import { createClient } from "@supabase/supabase-js";

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta ${name}. Defínela en .env.local (ver .env.example).`);
    process.exit(1);
  }
  return value;
}

const email = need("OWNER_EMAIL").trim().toLowerCase();
const url = need("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = need("SUPABASE_SERVICE_ROLE_KEY");
const siteUrl = need("NEXT_PUBLIC_SITE_URL").replace(/\/+$/, "");

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("OWNER_EMAIL no es un correo válido.");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function fatal(message: string, detail?: unknown): never {
  console.error(message);
  if (detail && typeof detail === "object" && "message" in detail) {
    console.error(String((detail as { message: unknown }).message));
  }
  process.exit(1);
}

const { data: role, error: roleError } = await admin
  .from("roles")
  .select("id")
  .eq("key", "owner")
  .maybeSingle();
if (roleError || !role) {
  fatal("No se encontró el rol owner. ¿Aplicaste supabase/migrations/0001_auth.sql?", roleError);
}

// ¿Ya hay un owner activo?
const { data: owners, error: ownersError } = await admin
  .from("profiles")
  .select("id, email, status")
  .eq("role_id", role.id);
if (ownersError) fatal("No se pudo consultar los perfiles.", ownersError);
if (owners.some((p) => p.status === "active")) {
  console.log("Ya existe un owner activo. No se hace nada.");
  process.exit(0);
}

// ¿Quedó una invitación de owner a medias? Se renueva y se recrea el usuario sin aceptar.
const { data: pending, error: pendingError } = await admin
  .from("invitations")
  .select("id, email")
  .eq("role_id", role.id)
  .eq("status", "pending");
if (pendingError) fatal("No se pudo consultar las invitaciones.", pendingError);

const existing = pending[0];
if (existing) {
  if (existing.email.toLowerCase() !== email) {
    fatal(`Hay una invitación de owner pendiente para otro correo (${existing.email}). Revísala en Supabase.`);
  }
  const { error } = await admin
    .from("invitations")
    .update({ expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() })
    .eq("id", existing.id);
  if (error) fatal("No se pudo renovar la invitación.", error);

  const stale = owners.find((p) => p.email.toLowerCase() === email);
  if (stale) {
    const { error: deleteError } = await admin.auth.admin.deleteUser(stale.id);
    if (deleteError) fatal("No se pudo recrear el usuario pendiente.", deleteError);
  }
} else {
  const { error } = await admin
    .from("invitations")
    .insert({ email, role_id: role.id, invited_by: null });
  if (error) fatal("No se pudo crear la invitación del owner.", error);
}

const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
  redirectTo: `${siteUrl}/auth/callback?next=/invitacion`,
});
if (inviteError) {
  fatal(
    "No se pudo enviar el correo de invitación (¿SMTP configurado? ¿límite de envíos?). " +
      "Vuelve a ejecutar el script cuando lo soluciones.",
    inviteError,
  );
}

console.log(`Invitación de owner enviada a ${email}.`);
console.log("Abre el enlace del correo, crea tu contraseña y entra en /login.");
