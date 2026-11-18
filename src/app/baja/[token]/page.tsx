import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Notice } from "@/components/ui/Notice";
import { EVENT_LABEL } from "@/lib/notifications/events";
import { readUnsubscribe } from "@/lib/notifications/unsubscribe";
import { UnsubscribeForm } from "./UnsubscribeForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Darse de baja", robots: { index: false, follow: false } };

/** Baja de un tipo de aviso desde el enlace del correo: sin iniciar sesión; solo cambia al pulsar el botón. */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const parsed = readUnsubscribe(token);
  if (!parsed) notFound();
  const what = parsed.event === "digest" ? "el resumen diario" : `los avisos de «${EVENT_LABEL[parsed.event].label}»`;
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="flex w-full max-w-sm flex-col gap-5 rounded-block border border-line bg-surface p-6">
        <h1 className="text-heading text-text">Darse de baja</h1>
        <p className="text-body text-text-2">Dejarás de recibir por correo {what}. Podrás volver a activarlos cuando quieras en tus preferencias de avisos.</p>
        <UnsubscribeForm token={token} />
        <Notice variant="info">Los avisos seguirán disponibles en la campana de la plataforma si tienes cuenta.</Notice>
      </div>
    </main>
  );
}
