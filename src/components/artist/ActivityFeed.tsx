"use client";

import { useState, useTransition } from "react";
import { listArtistActivity, type ActivityEntry } from "@/app/actions/browse";
import { ShieldIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { actionText } from "@/lib/activity-labels";

const when = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Atlantic/Canary",
});

/** Actividad del artista (publicaciones, subidas, descargas, accesos…), paginada por cursor. */
export function ActivityFeed({
  artistId,
  initial,
  initialCursor,
}: {
  artistId: string;
  initial: ActivityEntry[];
  initialCursor: string | null;
}) {
  const [items, setItems] = useState(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const more = () =>
    startTransition(async () => {
      const res = await listArtistActivity({ artistId, cursor });
      if (res.ok && res.data) {
        setItems((current) => [...current, ...res.data!.items]);
        setCursor(res.data.nextCursor);
        setError(null);
      } else setError(res.ok ? "No se pudo cargar más." : res.message);
    });

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<ShieldIcon size={22} />}
        title="Sin actividad todavía"
        description="Aquí aparecerán las subidas, publicaciones, descargas y cambios de acceso de este artista."
      />
    );
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Actividad">
      <ol className="divide-y divide-line rounded-card border border-line bg-surface">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-3 px-4 py-3.5">
            <Avatar name={item.actorName} size="sm" />
            <p className="min-w-0 flex-1 text-body text-text">
              <span className="font-medium">{item.actorName}</span> <span className="text-text-2">{actionText(item.action)}</span>
              {item.detail ? <span className="text-text"> · {item.detail}</span> : null}
            </p>
            <time dateTime={item.createdAt} className="shrink-0 text-caption text-text-3">
              {when.format(new Date(item.createdAt))}
            </time>
          </li>
        ))}
      </ol>
      {error ? <p className="text-label text-text-2">{error}</p> : null}
      {cursor ? (
        <div className="flex justify-center">
          <Button variant="ghost" onClick={more} disabled={pending}>
            {pending ? "Cargando…" : "Cargar más"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
