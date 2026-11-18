import "server-only";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Actor } from "@/lib/auth/session";
import { getActor } from "@/lib/auth/session";
import { getVaultCookieSecret, isVaultConfigured } from "@/lib/env";
import type { Action, ResourceRef } from "@/lib/permissions/keys";
import { can, ForbiddenError, userHasPermission } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sessionCookieOptions } from "@/lib/supabase/cookies";
import { createClient } from "@/lib/supabase/server";
import { remainingSeconds, renewUnlock, signUnlock, verifyUnlock, type UnlockPayload } from "./unlock-token";

/**
 * Control de acceso del Vault. FALLA CERRADO: cualquier duda, error o configuración ausente deniega.
 *
 * Una acción del Vault exige TODO esto, en este orden:
 *   1. cuenta activa (getActor) y permiso `vault.<acción>` en el rol
 *   2. `can_access` en la base de datos (rol + grant vigente del Vault o de la carpeta + recurso)
 *   3. sesión aal2 (TOTP verificado) — se lee del JWT de la sesión ya validada con Supabase Auth
 *   4. cookie de desbloqueo firmada, de ESTA persona y ESTA sesión, no caducada
 * y, antes de devolver nada (URLs, listados), el registro en activity_log (ver log.ts).
 */

export const UNLOCK_COOKIE = "vault_unlock";

type SessionInfo = { aal: string; sessionId: string };

/** aal y session_id del JWT de la sesión actual (el token ya fue validado por getActor → auth.getUser). */
async function readSession(): Promise<SessionInfo | null> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { aal?: string; session_id?: string };
    return { aal: typeof payload.aal === "string" ? payload.aal : "aal1", sessionId: typeof payload.session_id === "string" ? payload.session_id : "" };
  } catch {
    return null;
  }
}

export type MfaState = { enrolled: boolean; verified: boolean };

/** ¿Tiene la persona un factor TOTP verificado? (la verificación en dos pasos está activada). */
export async function getMfaState(): Promise<MfaState> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) return { enrolled: false, verified: false };
    return { enrolled: (data.totp?.length ?? 0) > 0, verified: (data.totp?.length ?? 0) > 0 };
  } catch {
    return { enrolled: false, verified: false };
  }
}

/**
 * ¿Debe VER el Vault esta persona (menú y ruta)? Rol con `vault.view` y, salvo el owner, un grant vigente
 * (con caducidad) del Vault entero o de alguna carpeta del Vault. Sin esto: ni menú ni ruta (404).
 */
export async function hasVaultEntitlement(actor: Actor): Promise<boolean> {
  try {
    if (!(await userHasPermission(actor.id, "vault.view"))) return false;
    if (actor.roleKey === "owner") return true;
    const admin = createAdminClient();
    const { data } = await admin
      .from("grants")
      .select("resource_type, resource_id")
      .eq("user_id", actor.id)
      .eq("can_view", true)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .in("resource_type", ["vault", "folder"])
      .limit(100);
    const rows = (data ?? []) as { resource_type: string; resource_id: string | null }[];
    if (rows.some((r) => r.resource_type === "vault")) return true;
    const folderIds = rows.filter((r) => r.resource_type === "folder" && r.resource_id).map((r) => r.resource_id as string);
    if (folderIds.length === 0) return false;
    const { data: vaultFolders } = await admin.from("folders").select("id").in("id", folderIds).eq("space", "vault").is("deleted_at", null).limit(1);
    return (vaultFolders?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export type VaultState =
  | { state: "no-access" }
  | { state: "unconfigured"; actor: Actor }
  | { state: "mfa-required"; actor: Actor }
  | { state: "locked"; actor: Actor; needsCode: boolean }
  | { state: "open"; actor: Actor };

/** Estado del Vault para una PÁGINA: 404 si no hay acceso; si lo hay, qué falta para abrirlo. */
export async function getVaultState(): Promise<VaultState> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (!(await hasVaultEntitlement(actor))) return { state: "no-access" };
  if (!isVaultConfigured() || !getVaultCookieSecret()) return { state: "unconfigured", actor };
  const mfa = await getMfaState();
  if (!mfa.enrolled) return { state: "mfa-required", actor };
  const session = await readSession();
  const secret = getVaultCookieSecret();
  const token = (await cookies()).get(UNLOCK_COOKIE)?.value;
  const valid = Boolean(session && secret && verifyUnlock(token, secret, { userId: actor.id, sessionId: session.sessionId }).ok && session.aal === "aal2");
  return valid ? { state: "open", actor } : { state: "locked", actor, needsCode: session?.aal !== "aal2" };
}

/** Para páginas del Vault: 404 sin acceso; devuelve el estado. */
export async function requireVaultPage(): Promise<Exclude<VaultState, { state: "no-access" }>> {
  const st = await getVaultState();
  if (st.state === "no-access") notFound();
  return st;
}

/** Emite o renueva la cookie de desbloqueo (solo desde acciones de servidor, donde se pueden escribir cookies). */
export async function setUnlockCookie(payload: UnlockPayload): Promise<void> {
  const secret = getVaultCookieSecret();
  if (!secret) throw new ForbiddenError();
  const store = await cookies();
  store.set(UNLOCK_COOKIE, signUnlock(payload, secret), {
    ...sessionCookieOptions(),
    httpOnly: true,
    sameSite: "strict",
    maxAge: remainingSeconds(payload),
  });
}

export async function clearUnlockCookie(): Promise<void> {
  (await cookies()).set(UNLOCK_COOKIE, "", { ...sessionCookieOptions(), sameSite: "strict", maxAge: 0 });
}

/** Datos de la sesión actual para crear el desbloqueo (aal2 obligatorio). null si no es aal2. */
export async function currentAal2Session(): Promise<string | null> {
  const session = await readSession();
  return session && session.aal === "aal2" && session.sessionId ? session.sessionId : null;
}

/**
 * Barrera de TODA acción del Vault. Devuelve el actor o lanza ForbiddenError (que `runAction` convierte en un
 * resultado seguro). `touch` renueva la cookie por actividad.
 */
export async function requireVaultAccess(
  action: Action,
  resource: ResourceRef = { type: "vault", id: null },
  options: { touch?: boolean; folderScoped?: boolean } = {},
): Promise<Actor> {
  try {
    const actor = await getActor();
    if (!actor) throw new ForbiddenError();
    if (!isVaultConfigured()) throw new ForbiddenError();
    const secret = getVaultCookieSecret();
    if (!secret) throw new ForbiddenError();

    if (!(await userHasPermission(actor.id, `vault.${action}` as never))) throw new ForbiddenError();
    // Acciones «de entrada» (inicio del Vault, renovar el desbloqueo, destinos de subida): quien solo tiene acceso a
    // CARPETAS concretas no tiene grant del Vault entero. Para ellas basta el derecho de ver el Vault (rol + algún
    // grant vigente); cada carpeta se autoriza luego por separado con su propio `can_access`.
    if (options.folderScoped && resource.type === "vault") {
      if (!(await hasVaultEntitlement(actor))) throw new ForbiddenError();
    } else if (!(await can(actor.id, action, resource))) {
      throw new ForbiddenError();
    }

    const session = await readSession();
    if (!session || session.aal !== "aal2" || !session.sessionId) throw new ForbiddenError();
    const token = (await cookies()).get(UNLOCK_COOKIE)?.value;
    const check = verifyUnlock(token, secret, { userId: actor.id, sessionId: session.sessionId });
    if (!check.ok) throw new ForbiddenError();

    if (options.touch !== false) {
      try {
        await setUnlockCookie(renewUnlock(check.payload));
      } catch {
        /* en un Server Component las cookies son de solo lectura: la renovación la hace la siguiente acción */
      }
    }
    return actor;
  } catch (error) {
    if (error instanceof ForbiddenError) throw error;
    if (error instanceof Error && "digest" in error) throw error;
    throw new ForbiddenError(); // cualquier fallo inesperado: se deniega
  }
}
