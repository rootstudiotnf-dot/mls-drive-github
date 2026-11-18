/** Resultado estándar de las acciones de servidor consumidas por la interfaz. */
export type ActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; message: string };

export function ok<T = undefined>(message?: string, data?: T): ActionResult<T> {
  return { ok: true, message, data };
}

export function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

export const NOT_ALLOWED = "No tienes permiso para hacer esto.";
export const GENERIC_ERROR = "No se pudo completar la acción. Inténtalo de nuevo.";
