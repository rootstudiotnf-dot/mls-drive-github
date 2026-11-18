import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { LOCK_MS, MAX_UNLOCK_FAILURES, nextFailureState } from "./unlock-token";

/**
 * Límite de intentos de desbloqueo (y de uso de códigos de recuperación): 5 fallos seguidos → bloqueo de 15 minutos
 * por persona. Tabla `vault_unlock_attempts` (solo service role).
 */

export type LockState = { locked: false; failures: number } | { locked: true; minutes: number };

export async function readLock(userId: string): Promise<LockState> {
  const { data } = await createAdminClient().from("vault_unlock_attempts").select("failures, locked_until").eq("user_id", userId).maybeSingle();
  const row = data as { failures: number; locked_until: string | null } | null;
  if (row?.locked_until && Date.parse(row.locked_until) > Date.now()) {
    return { locked: true, minutes: Math.max(1, Math.ceil((Date.parse(row.locked_until) - Date.now()) / 60_000)) };
  }
  return { locked: false, failures: row?.failures ?? 0 };
}

/** Registra un fallo; devuelve si ese fallo provoca el bloqueo. */
export async function recordFailure(userId: string, previous: number): Promise<{ locked: boolean }> {
  const state = nextFailureState(previous);
  await createAdminClient().from("vault_unlock_attempts").upsert({
    user_id: userId,
    failures: state.failures,
    locked_until: state.lockedUntil ? new Date(state.lockedUntil).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  return { locked: state.lockedUntil !== null };
}

export async function clearFailures(userId: string): Promise<void> {
  await createAdminClient().from("vault_unlock_attempts").upsert({ user_id: userId, failures: 0, locked_until: null, updated_at: new Date().toISOString() });
}

export const LOCK_MESSAGE = `Demasiados intentos fallidos. El Vault queda bloqueado ${Math.round(LOCK_MS / 60_000)} minutos.`;
export const LOCK_THRESHOLD = MAX_UNLOCK_FAILURES;
