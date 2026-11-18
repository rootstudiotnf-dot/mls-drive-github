import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TestAlertButton } from "@/components/ops/TestAlertButton";
import { Badge } from "@/components/ui/Badge";
import { DataList, DataRow } from "@/components/ui/DataRow";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { requireActor } from "@/lib/auth/session";
import { collectHealth, type CheckStatus } from "@/lib/ops/health";

export const metadata: Metadata = { title: "Estado de los servicios" };
export const dynamic = "force-dynamic";

const LABEL: Record<CheckStatus, string> = { ok: "Correcto", warn: "Revisar", fail: "Fallo", off: "No configurado" };
const when = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Atlantic/Canary" });

/** Solo el owner (rol único e inmutable). Cualquier otra persona recibe un 404. */
export default async function StatusPage() {
  const actor = await requireActor();
  if (actor.roleKey !== "owner") notFound();
  const health = await collectHealth();
  const bad = health.checks.filter((c) => c.status === "fail" || c.status === "warn").length;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Estado de los servicios"
        description={`${bad === 0 ? "Todo en orden." : `${bad} ${bad === 1 ? "cosa por revisar" : "cosas por revisar"}.`} Medido ${when.format(new Date(health.generatedAt))}.`}
        actions={<TestAlertButton />}
      />

      <section>
        <SectionHeader title="Servicios" />
        <DataList>
          {health.checks.map((c) => (
            <DataRow key={c.key} title={c.label} subtitle={c.detail} trailing={<Badge variant={c.status === "ok" ? "neutral" : c.status === "off" ? "outline" : "solid"}>{LABEL[c.status]}</Badge>} />
          ))}
        </DataList>
      </section>

      <section>
        <SectionHeader title={`Errores recientes (${health.errors24h} en 24 h)`} />
        {health.recentErrors.length === 0 ? (
          <EmptyState title="Sin errores registrados" description="Aquí aparecen el ámbito y el tipo de cada error del servidor o del navegador. Nunca su contenido." />
        ) : (
          <DataList>
            {health.recentErrors.map((e) => (
              <DataRow key={e.id} title={`${e.scope} · ${e.name}`} subtitle={`${e.code ? `código ${e.code} · ` : ""}${when.format(new Date(e.createdAt))}`} />
            ))}
          </DataList>
        )}
      </section>
    </div>
  );
}
