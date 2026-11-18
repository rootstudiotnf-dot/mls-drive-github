import type { Metadata } from "next";
import { getPreferences } from "@/app/actions/notifications";
import { PreferencesForm } from "@/components/notifications/PreferencesForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { TextLink } from "@/components/ui/TextLink";
import { requireActor } from "@/lib/auth/session";
import { DEFAULTS } from "@/lib/notifications/events";

export const metadata: Metadata = { title: "Avisos" };
export const dynamic = "force-dynamic";

export default async function NotificationSettingsPage() {
  await requireActor();
  const prefs = await getPreferences();
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Avisos" description="Qué te avisamos y cómo. Los avisos dentro de la plataforma siempre llegan; aquí eliges los correos." actions={<TextLink href="/">Volver</TextLink>} />
      <PreferencesForm initial={prefs.ok && prefs.data ? prefs.data : DEFAULTS} />
    </div>
  );
}
