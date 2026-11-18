"use server";

import { fail, ok, type ActionResult } from "@/lib/action-result";
import { requireActor } from "@/lib/auth/session";
import { sendTestAlert } from "@/lib/ops/alerts";
import { ForbiddenError, runAction } from "@/lib/permissions/server";

/** Prueba forzada de los avisos por correo. Solo el owner (rol único e inmutable). */
export async function sendTestAlertEmail(): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireActor();
    if (actor.roleKey !== "owner") throw new ForbiddenError();
    return (await sendTestAlert()) ? ok("Correo de prueba enviado. Revisa la bandeja del owner.") : fail("No se pudo enviar: revisa RESEND_API_KEY y MAIL_FROM.");
  });
}
