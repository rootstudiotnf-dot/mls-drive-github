"use server";

import { getActor } from "@/lib/auth/session";
import { recordError } from "@/lib/ops/errors";

/**
 * Aviso de un error de interfaz desde el navegador. Solo guarda el nombre del error y el identificador (`digest`)
 * que Next asigna al error del servidor: nunca el mensaje ni la pila. Requiere sesión (evita que cualquiera llene
 * el registro) y el registro tiene su propio tope por minuto.
 */
export async function reportClientError(input: { name?: unknown; digest?: unknown }): Promise<void> {
  try {
    if (!(await getActor())) return;
    const name = typeof input?.name === "string" ? input.name : "Error";
    const digest = typeof input?.digest === "string" ? input.digest : null;
    const error = new Error();
    error.name = name;
    await recordError("client", error, digest);
  } catch {
    // nunca falla hacia el navegador
  }
}
