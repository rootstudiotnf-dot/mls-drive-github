import type { Metadata } from "next";
import { SearchField } from "@/components/layout/SearchField";
import { FolderCard } from "@/components/ui/FolderCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { PhotoTile } from "@/components/ui/PhotoTile";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { TextLink } from "@/components/ui/TextLink";
import { redirect } from "next/navigation";
import { requireActor } from "@/lib/auth/session";
import { hasAdminShell } from "@/lib/permissions/portal";
import { getEffectiveRole } from "@/lib/permissions/server";
import { artists, sessions } from "@/lib/sample-data";

export const metadata: Metadata = { title: "Inicio" };

// La fecha y el saludo dependen del momento de la petición.
export const dynamic = "force-dynamic";

const TIME_ZONE = "Atlantic/Canary";

function greeting(now: Date) {
  const hour =
    Number(
      new Intl.DateTimeFormat("es-ES", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone: TIME_ZONE,
      }).format(now),
    ) % 24;
  if (hour < 6) return "Buenas noches";
  if (hour < 13) return "Buenos días";
  if (hour < 21) return "Buenas tardes";
  return "Buenas noches";
}

export default async function HomePage() {
  const actor = await requireActor();
  // Redirección por rol: artistas y colaboradores aterrizan en su espacio, no en el inicio de administración.
  const role = await getEffectiveRole();
  if (!role || !hasAdminShell(role.permissions)) redirect("/espacio");
  const firstName = actor.displayName.split(" ")[0] ?? actor.displayName;
  const now = new Date();
  const date = new Intl.DateTimeFormat("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: TIME_ZONE,
  }).format(now);

  return (
    <div className="flex flex-col gap-12">
      <PageHeader
        eyebrow={date}
        title={`${greeting(now)}, ${firstName}`}
        actions={<SearchField />}
      />

      <section>
        <SectionHeader
          title="Sesiones recientes"
          action={
            <TextLink href="/sesiones">Ver todas</TextLink>
          }
        />
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-5 md:grid-cols-3 wide:grid-cols-4">
          {sessions.map((session) => (
            <PhotoTile
              key={session.id}
              href="/sesiones"
              tone={session.tone}
              title={session.title}
              meta={session.meta}
            />
          ))}
        </div>
      </section>

      <section>
        <SectionHeader
          title="Artistas"
          action={
            <TextLink href="/artistas">Ver todos</TextLink>
          }
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 wide:grid-cols-4">
          {artists.map((artist) => (
            <FolderCard
              key={artist.id}
              href="/artistas"
              name={artist.name}
              meta={artist.meta}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
