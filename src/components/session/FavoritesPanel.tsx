"use client";

import { useState } from "react";
import { HeartIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { DataList, DataRow } from "@/components/ui/DataRow";
import { EmptyState } from "@/components/ui/EmptyState";
import type { FavoriteEntry } from "@/lib/sessions/types";

const when = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", timeZone: "Atlantic/Canary" });

/** Fotos marcadas como favoritas por los artistas, con quién las marcó, y exportación de la lista de nombres. */
export function FavoritesPanel({ entries, sessionName }: { entries: FavoriteEntry[]; sessionName: string }) {
  const [copied, setCopied] = useState(false);
  const text = entries.map((e) => e.filename).join("\n");

  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `favoritas-${sessionName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sesion"}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<HeartIcon size={22} />}
        title="Aún no hay favoritas"
        description="Cuando los artistas marquen fotos con el corazón, aparecerán aquí con el nombre de quien las eligió."
      />
    );
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Favoritas">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-label text-text-2">
          {entries.length} {entries.length === 1 ? "foto favorita" : "fotos favoritas"}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 2500);
              } catch {
                download();
              }
            }}
          >
            {copied ? "Lista copiada" : "Copiar lista"}
          </Button>
          <Button size="sm" onClick={download}>
            Exportar nombres (.txt)
          </Button>
        </div>
      </div>
      <DataList>
        {entries.map((entry) => (
          <DataRow
            key={entry.assetId}
            leading={<HeartIcon size={18} className="text-text-2" fill="currentColor" />}
            title={entry.filename}
            subtitle={entry.by.map((b) => `${b.name} (${when.format(new Date(b.at))})`).join(" · ")}
          />
        ))}
      </DataList>
    </section>
  );
}
