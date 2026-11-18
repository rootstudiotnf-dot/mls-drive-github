"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { revokeShareLink, type ShareEvent, type ShareLinkSummary } from "@/app/actions/share";
import { LinkIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DataList, DataRow } from "@/components/ui/DataRow";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";

const when = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Atlantic/Canary" });
const STATE_LABEL = { active: "Activo", expired: "Caducado", revoked: "Revocado" } as const;
const EVENT_LABEL: Record<string, string> = { open: "Apertura", view: "Vista", download: "Descarga", password_fail: "Contraseña incorrecta", comment: "Comentario" };

/** Enlaces externos: lista con estado, visitas, descargas y caducidad. Revocar es inmediato. */
export function LinksPanel({ links, detail }: { links: ShareLinkSummary[]; detail: { link: ShareLinkSummary; events: ShareEvent[] } | null }) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const revoke = (id: string) =>
    startTransition(async () => {
      const res = await revokeShareLink(id);
      setMessage({ ok: res.ok, text: res.message ?? (res.ok ? "Enlace revocado." : "No se pudo revocar.") });
      router.refresh();
    });

  return (
    <section className="flex flex-col gap-6">
      <SectionHeader title="Enlaces externos" />
      {message ? <Notice variant={message.ok ? "success" : "error"}>{message.text}</Notice> : null}
      {links.length === 0 ? (
        <EmptyState icon={<LinkIcon size={22} />} title="Sin enlaces todavía" description="Crea uno con «Compartir» en una sesión, una carpeta, una selección de fotos o un beat. Cada enlace caduca y se puede revocar al instante." />
      ) : (
        <DataList>
          {links.map((l) => (
            <div key={l.id} className="flex items-center">
              <Link href={`/accesos?tab=enlaces&enlace=${l.id}`} className="block min-w-0 flex-1" aria-label={`Ver detalle de ${l.title}`}>
                <DataRow
                  title={l.title}
                  subtitle={`${l.target} · ${l.views} ${l.views === 1 ? "visita" : "visitas"} · ${l.downloads}${l.maxDownloads ? `/${l.maxDownloads}` : ""} ${l.downloads === 1 ? "descarga" : "descargas"} · caduca ${when.format(new Date(l.expiresAt))}`}
                  trailing={<Badge variant={l.state === "active" ? "neutral" : "outline"}>{STATE_LABEL[l.state]}</Badge>}
                />
              </Link>
              {l.state === "active" ? (
                <div className="pr-4">
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => revoke(l.id)} aria-label={`Revocar ahora ${l.title}`}>
                    Revocar ahora
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </DataList>
      )}

      {detail ? (
        <div className="flex flex-col gap-4 rounded-card border border-line bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-heading text-text">{detail.link.title}</h3>
              <p className="mt-1 text-label text-text-2">
                {detail.link.target} · creado por {detail.link.creator} · {when.format(new Date(detail.link.createdAt))}
              </p>
              <p className="mt-1 flex flex-wrap gap-2 text-caption text-text-3">
                {detail.link.hasPassword ? <Badge variant="outline">Con contraseña</Badge> : null}
                {detail.link.canDownload ? <Badge variant="outline">Descarga permitida</Badge> : null}
                {detail.link.canComment ? <Badge variant="outline">Comentarios</Badge> : null}
                <Badge variant={detail.link.state === "active" ? "neutral" : "outline"}>{STATE_LABEL[detail.link.state]}</Badge>
              </p>
            </div>
            {detail.link.state === "active" ? (
              <Button size="sm" disabled={pending} onClick={() => revoke(detail.link.id)}>
                Revocar ahora
              </Button>
            ) : null}
          </div>
          <h4 className="text-label font-medium text-text-2">Historial (últimos 100 eventos)</h4>
          {detail.events.length === 0 ? (
            <p className="text-label text-text-3">Nadie ha abierto este enlace todavía.</p>
          ) : (
            <ol className="divide-y divide-line">
              {detail.events.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-3 py-2 text-label">
                  <span className="text-text">{EVENT_LABEL[e.type] ?? e.type}</span>
                  <span className="min-w-0 flex-1 truncate text-text-3">
                    visitante {e.who}
                    {e.userAgent ? ` · ${e.userAgent}` : ""}
                  </span>
                  <time className="shrink-0 text-caption text-text-3">{when.format(new Date(e.createdAt))}</time>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}
