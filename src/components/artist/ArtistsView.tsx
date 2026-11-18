"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getThumbUrls } from "@/app/actions/browse";
import { FolderIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

export type ArtistCardData = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "archived";
  avatarAssetId: string | null;
  summary: {
    photos: number;
    videos: number;
    files: number;
    sessions: number;
    pending: number;
    members: number;
  };
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function summaryText(s: ArtistCardData["summary"]): string {
  const parts = [plural(s.photos, "foto", "fotos"), plural(s.videos, "vídeo", "vídeos")];
  if (s.files > 0) parts.push(plural(s.files, "archivo", "archivos"));
  return parts.join(" · ");
}

/** Rejilla de artistas: tile 16/10 con avatar, nombre y resumen. Las miniaturas se piden en UNA sola llamada. */
export function ArtistsView({
  artists,
  basePath = "/artistas",
  showPending = true,
}: {
  artists: ArtistCardData[];
  /** Ruta base de cada enlace (el portal usa /espacio). */
  basePath?: string;
  /** El portal no enseña el contador de pendientes. */
  showPending?: boolean;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const ids = artists.map((a) => a.avatarAssetId).filter((v): v is string => !!v);
    if (ids.length === 0) return;
    let cancelled = false;
    void getThumbUrls(ids).then((res) => {
      if (!cancelled && res.ok && res.data) setUrls(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [artists]);

  return (
    <ul className="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 wide:grid-cols-3">
      {artists.map((artist) => {
        const url = artist.avatarAssetId ? urls[artist.avatarAssetId] : undefined;
        return (
          <li key={artist.id}>
            <Link href={`${basePath}/${artist.slug}`} className="group block rounded-card">
              <div
                className={cn(
                  "relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-card border border-line bg-tone-2",
                  "transition-colors duration-150 ease-ui group-hover:border-line-hover",
                )}
              >
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
                ) : (
                  <span className="flex flex-col items-center gap-2 text-text-3">
                    <FolderIcon size={26} />
                    <span className="text-heading text-text-2" aria-hidden="true">
                      {artist.name.slice(0, 2).toUpperCase()}
                    </span>
                  </span>
                )}
                {showPending && artist.summary.pending > 0 ? (
                  <span className="absolute top-3 right-3">
                    <Badge variant="solid">{plural(artist.summary.pending, "pendiente", "pendientes")}</Badge>
                  </span>
                ) : null}
              </div>
              <div className="mt-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-body font-medium text-text">{artist.name}</p>
                  <p className="truncate text-label text-text-2">{summaryText(artist.summary)}</p>
                </div>
                {artist.status === "archived" ? <Badge variant="outline">Archivado</Badge> : null}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
