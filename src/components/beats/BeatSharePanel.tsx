"use client";

import { useState, useTransition } from "react";
import { shareBeat, unshareBeat } from "@/app/actions/beats";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import { KeyIcon } from "@/components/icons";

type Shared = { artistId: string; name: string; canDownload: boolean };

/**
 * Con qué artistas se comparte un beat. Compartir solo da ACCESO A ESCUCHAR (y solo cuando el beat está publicado);
 * la descarga del original exige además «Puede descargar» aquí, la opción del beat y el permiso del rol. Quitar el
 * acceso es inmediato: el artista deja de verlo y las URLs ya firmadas caducan solas (5 min / 15 min).
 */
export function BeatSharePanel({
  beatId,
  status,
  shared,
  artists,
  canEdit,
  canGrantDownload,
  onChanged,
}: {
  beatId: string;
  status: "draft" | "published";
  shared: Shared[];
  artists: { id: string; name: string }[];
  canEdit: boolean;
  canGrantDownload: boolean;
  onChanged: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const available = artists.filter((a) => !shared.some((s) => s.artistId === a.id));

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      setMessage(res.ok ? null : (res.message ?? "No se pudo completar la acción."));
      if (res.ok) onChanged();
    });

  return (
    <section aria-labelledby="share-title">
      <SectionHeader title="Compartido con" />
      <h3 id="share-title" className="sr-only">
        Compartido con
      </h3>
      {status === "draft" ? (
        <Notice variant="info" className="mb-4">
          El beat es un borrador: los artistas no lo verán hasta que lo publiques, aunque lo compartas ya.
        </Notice>
      ) : null}
      {message ? (
        <Notice variant="error" className="mb-4">
          {message}
        </Notice>
      ) : null}

      {shared.length === 0 ? (
        <EmptyState icon={<KeyIcon size={22} />} title="Sin compartir" description="Solo lo ve el equipo con acceso a beats." />
      ) : (
        <ul className="flex flex-col gap-2">
          {shared.map((s) => (
            <li key={s.artistId} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-body font-medium text-text">{s.name}</p>
                {s.canDownload ? <Badge variant="outline">Puede descargar</Badge> : <Badge variant="neutral">Solo escuchar</Badge>}
              </div>
              {canEdit ? (
                <div className="flex items-center gap-3">
                  <Toggle
                    label={`Puede descargar (${s.name})`}
                    checked={s.canDownload}
                    disabled={pending || (!canGrantDownload && !s.canDownload)}
                    onChange={(value) => run(() => shareBeat(beatId, s.artistId, value))}
                  />
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => unshareBeat(beatId, s.artistId))}>
                    Quitar acceso
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="w-64 max-w-full">
            <Select
              label="Compartir con un artista"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              options={[{ value: "", label: available.length === 0 ? "No quedan artistas" : "Elige un artista…" }, ...available.map((a) => ({ value: a.id, label: a.name }))]}
            />
          </div>
          <Button
            size="md"
            disabled={pending || !choice}
            onClick={() => {
              const artistId = choice;
              setChoice("");
              run(() => shareBeat(beatId, artistId, false));
            }}
          >
            Compartir
          </Button>
        </div>
      ) : null}
      {!canGrantDownload && canEdit ? <p className="mt-3 text-caption text-text-3">Tu rol no puede conceder descargas del original.</p> : null}
    </section>
  );
}
