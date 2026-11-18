"use server";

import { fail, GENERIC_ERROR, ok, type ActionResult } from "@/lib/action-result";
import { getActor } from "@/lib/auth/session";
import { runAction, ForbiddenError } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { verifyPassword } from "@/lib/supabase/verify";
import { clearUnlockCookie, currentAal2Session } from "@/lib/vault/access";
import { clearFailures, LOCK_MESSAGE, readLock, recordFailure } from "@/lib/vault/attempts";
import { logVaultBestEffort } from "@/lib/vault/log";
import { matchesRecoveryCode, newRecoverySet } from "@/lib/vault/recovery";

/**
 * Verificación en dos pasos (TOTP con Supabase Auth MFA) y códigos de recuperación. Cualquier persona con acceso al
 * Vault debe tenerla activada. Los códigos de recuperación se muestran UNA vez y solo se guarda su hash con sal.
 */

async function actorOrDeny() {
  const actor = await getActor();
  if (!actor) throw new ForbiddenError();
  return actor;
}

export type MfaStatus = { enrolled: boolean; recoveryLeft: number };

export async function getMfaStatus(): Promise<ActionResult<MfaStatus>> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    const supabase = await createClient();
    const { data } = await supabase.auth.mfa.listFactors();
    const { count } = await createAdminClient().from("mfa_recovery_codes").select("id", { count: "exact", head: true }).eq("user_id", actor.id).is("used_at", null);
    return ok<MfaStatus>(undefined, { enrolled: (data?.totp?.length ?? 0) > 0, recoveryLeft: count ?? 0 });
  });
}

export type Enrollment = { factorId: string; qr: string; secret: string };

/** Empieza la activación: devuelve el QR (SVG) y la clave para introducirla a mano. Descarta intentos sin confirmar. */
export async function startTotpEnrollment(): Promise<ActionResult<Enrollment>> {
  return runAction(async () => {
    await actorOrDeny();
    const supabase = await createClient();
    const { data: factors } = await supabase.auth.mfa.listFactors();
    if ((factors?.totp?.length ?? 0) > 0) return fail("La verificación en dos pasos ya está activada.");
    for (const f of factors?.all ?? []) if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `MLS Drive ${new Date().toISOString().slice(0, 10)}` });
    if (error || !data) return fail(GENERIC_ERROR);
    return ok<Enrollment>(undefined, { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  });
}

async function storeRecoveryCodes(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const set = newRecoverySet();
  await admin.from("mfa_recovery_codes").delete().eq("user_id", userId);
  const { error } = await admin.from("mfa_recovery_codes").insert(set.rows.map((r) => ({ ...r, user_id: userId })));
  if (error) throw new Error("recovery");
  return set.codes;
}

/** Confirma el código de 6 dígitos y, al activarla, genera los códigos de recuperación (se devuelven una vez). */
export async function confirmTotpEnrollment(input: { factorId: string; code: string }): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    const code = typeof input?.code === "string" ? input.code.replace(/\s+/g, "") : "";
    if (typeof input?.factorId !== "string" || !/^\d{6}$/.test(code)) return fail("Introduce el código de 6 dígitos.");
    const supabase = await createClient();
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: input.factorId, code });
    if (error) return fail("El código no es correcto. Comprueba la hora de tu dispositivo.");
    const recoveryCodes = await storeRecoveryCodes(actor.id);
    return ok("Verificación en dos pasos activada.", { recoveryCodes });
  });
}

/** Códigos de recuperación nuevos (invalidan los anteriores): exige contraseña y sesión aal2. */
export async function regenerateRecoveryCodes(input: { password: string }): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    if ((await currentAal2Session()) === null) return fail("Verifica tu código de dos pasos primero (abre el Vault).");
    const lock = await readLock(actor.id);
    if (lock.locked) return fail(`Demasiados intentos fallidos. Inténtalo de nuevo en ${lock.minutes} min.`);
    if (!(await verifyPassword(actor.email, String(input?.password ?? "")))) {
      const { locked } = await recordFailure(actor.id, lock.failures);
      return fail(locked ? LOCK_MESSAGE : "La contraseña no es correcta.");
    }
    await clearFailures(actor.id);
    return ok("Códigos nuevos generados.", { recoveryCodes: await storeRecoveryCodes(actor.id) });
  });
}

/**
 * «He perdido mi dispositivo»: con la contraseña y un código de recuperación se retira el factor TOTP actual
 * (tras lo cual hay que activar uno nuevo). El código usado queda gastado. Cuenta para el límite de intentos.
 */
export async function resetMfaWithRecoveryCode(input: { password: string; recoveryCode: string }): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await actorOrDeny();
    const lock = await readLock(actor.id);
    if (lock.locked) return fail(`Demasiados intentos fallidos. Inténtalo de nuevo en ${lock.minutes} min.`);
    const bad = async (): Promise<ActionResult> => {
      const { locked } = await recordFailure(actor.id, lock.failures);
      await logVaultBestEffort(actor.id, "vault.open", { ok: false, recovery: true, locked });
      return fail(locked ? LOCK_MESSAGE : "La contraseña o el código no son correctos.");
    };
    if (!(await verifyPassword(actor.email, String(input?.password ?? "")))) return bad();
    const admin = createAdminClient();
    const { data } = await admin.from("mfa_recovery_codes").select("id, salt, code_hash").eq("user_id", actor.id).is("used_at", null);
    const match = ((data ?? []) as { id: string; salt: string; code_hash: string }[]).find((row) => matchesRecoveryCode(String(input?.recoveryCode ?? ""), row));
    if (!match) return bad();
    const { error: spent } = await admin.from("mfa_recovery_codes").update({ used_at: new Date().toISOString() }).eq("id", match.id).is("used_at", null);
    if (spent) return fail(GENERIC_ERROR);
    const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId: actor.id });
    for (const f of factors?.factors ?? []) await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: actor.id });
    await clearFailures(actor.id);
    await clearUnlockCookie();
    await logVaultBestEffort(actor.id, "vault.open", { ok: false, recoveryReset: true });
    return ok("Verificación en dos pasos retirada. Actívala de nuevo para volver a abrir el Vault.");
  });
}
