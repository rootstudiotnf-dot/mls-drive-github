"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getVaultOverview, lockVault, type VaultOverview } from "@/app/actions/vault";
import { LockIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FolderCard } from "@/components/ui/FolderCard";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { TextLink } from "@/components/ui/TextLink";
import { VAULT_ACTION_LABEL } from "@/lib/vault/labels";
import { VaultKeepAlive } from "./VaultKeepAlive";

const when = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Atlantic/Canary" });

/** Inicio del Vault: aviso de acceso restringido, carpetas con candado y registro de acceso reciente. */
export function VaultHome() {
  const router = useRouter();
  const [overview, setOverview] = useState<VaultOverview | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getVaultOverview().then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) setOverview(res.data);
      else {
        setError(true);
        router.refresh(); // el servidor decide: ¿caducó el desbloqueo? ¿se revocó el acceso?
      }
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="flex flex-col gap-10">
      <VaultKeepAlive />
      <div className="flex flex-col gap-4 rounded-card border border-line-hover bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-tone-3 text-text">
            <LockIcon size={20} />
          </span>
          <div>
            <p className="text-body font-medium text-text">Acceso restringido</p>
            <p className="text-label text-text-2">Todo lo que haces aquí queda registrado. El Vault se bloquea solo tras 15 minutos sin actividad.</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {overview?.isOwner ? (
            <Link href="/vault/registro" className="inline-flex h-8 items-center rounded-pill border border-line px-3.5 text-label font-medium text-text transition-colors duration-150 ease-ui hover:border-line-hover hover:bg-hover">
              Registro completo
            </Link>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await lockVault();
              router.refresh();
            }}
          >
            Bloquear ahora
          </Button>
        </div>
      </div>

      {error ? <Notice variant="error">No se pudo cargar el Vault.</Notice> : null}

      <section aria-labelledby="vault-folders">
        <SectionHeader title="Carpetas" />
        <h3 id="vault-folders" className="sr-only">
          Carpetas del Vault
        </h3>
        {!overview ? (
          <p className="text-label text-text-2" role="status">
            Cargando…
          </p>
        ) : overview.folders.length === 0 ? (
          <EmptyState icon={<LockIcon size={22} />} title="No hay carpetas disponibles" description="Tu acceso no incluye ninguna carpeta del Vault." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {overview.folders.map((f) => (
              <FolderCard key={f.id} name={f.name} meta={`${f.items} ${f.items === 1 ? "elemento" : "elementos"}`} href={`/vault/${f.id}`} icon={<LockIcon size={20} />} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="vault-log">
        <SectionHeader title="Registro de acceso" action={overview?.isOwner ? <TextLink href="/vault/registro">Ver todo</TextLink> : <Badge variant="outline">Solo tus eventos</Badge>} />
        <h3 id="vault-log" className="sr-only">
          Registro de acceso
        </h3>
        {overview && overview.log.length > 0 ? (
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {overview.log.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 text-label">
                <span className="min-w-0 text-text-2">
                  <span className="font-medium text-text">{e.actorName}</span> · {VAULT_ACTION_LABEL[e.action] ?? e.action}
                  {e.detail ? <span className="text-text-3"> — {e.detail}</span> : null}
                </span>
                <time dateTime={e.createdAt} className="text-caption text-text-3">
                  {when.format(new Date(e.createdAt))}
                </time>
              </li>
            ))}
          </ul>
        ) : overview ? (
          <p className="text-label text-text-2">Todavía no hay eventos.</p>
        ) : null}
      </section>
    </div>
  );
}
