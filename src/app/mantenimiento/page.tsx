import type { Metadata } from "next";
import { AuthShell } from "@/components/layout/AuthShell";

export const metadata: Metadata = { title: "En mantenimiento" };

/** Página de mantenimiento: la sirve el proxy (503) mientras `MAINTENANCE_MODE=1`. Sin acceso a datos. */
export default function MaintenancePage() {
  return (
    <AuthShell title="Volvemos enseguida" description="Estamos haciendo tareas de mantenimiento. Tu contenido está a salvo. Inténtalo de nuevo en unos minutos." footer="MLS Drive">
      {null}
    </AuthShell>
  );
}
