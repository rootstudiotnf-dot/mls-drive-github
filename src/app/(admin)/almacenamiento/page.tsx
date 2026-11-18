import { hasVaultEntitlement } from "@/lib/vault/access";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { Progress } from "@/components/ui/Progress";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { getPricePerGbMonth } from "@/lib/env";
import { formatBytes } from "@/lib/format";
import { requirePagePermission } from "@/lib/permissions/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "Almacenamiento" };
export const dynamic = "force-dynamic";

type UsageRow = { kind: string; artist_id: string | null; files: number; bytes: number };

const KIND_LABEL: Record<string, string> = {
  photo: "Fotos",
  video: "Vídeos",
  audio: "Audio (beats)",
  document: "Archivos",
  other: "Otros",
  "derivative:thumb": "Miniaturas",
  "derivative:web": "Versiones web (foto)",
  "derivative:proxy": "Vídeos ligeros (proxy 1080p)",
  "derivative:poster": "Pósters de vídeo",
};

// R2 factura por GB (1 GB = 10^9 bytes) y mes
const BYTES_PER_GB = 1_000_000_000;

const money = new Intl.NumberFormat("es-ES", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-5">
      <p className="text-label text-text-2">{label}</p>
      <p className="mt-1.5 text-subtitle text-text">{value}</p>
      {hint ? <p className="mt-1 text-caption text-text-3">{hint}</p> : null}
    </div>
  );
}

function UsageList({ rows, total }: { rows: { label: string; bytes: number; files: number }[]; total: number }) {
  if (rows.length === 0) return <p className="text-body text-text-2">Todavía no hay archivos.</p>;
  return (
    <ul className="divide-y divide-line rounded-card border border-line bg-surface">
      {rows.map((row) => (
        <li key={row.label} className="grid gap-2 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-6">
          <div className="min-w-0">
            <p className="truncate text-body font-medium text-text">{row.label}</p>
            <p className="text-label text-text-2">{row.files === 1 ? "1 archivo" : `${row.files} archivos`}</p>
          </div>
          <Progress value={total > 0 ? row.bytes / total : 0} label={`Uso de ${row.label}`} />
          <p className="text-body text-text sm:w-24 sm:text-right">{formatBytes(row.bytes)}</p>
        </li>
      ))}
    </ul>
  );
}

export default async function AlmacenamientoPage() {
  // Barrera de servidor: administración (si no, 404). Las lecturas de uso se hacen con el service role
  // DESPUÉS de comprobar el permiso (son agregados de todo el almacenamiento).
  const actor = await requirePagePermission("access.manage", "users.manage", "roles.manage");
  // El Vault es una línea APARTE y solo la ve quien tiene acceso al Vault (para el resto, no existe)
  const showVault = await hasVaultEntitlement(actor);

  const admin = createAdminClient();
  const [usageRes, artistsRes] = await Promise.all([
    admin.rpc("storage_usage"),
    admin.from("artists").select("id, name"),
  ]);
  const usage = ((usageRes.data ?? []) as UsageRow[]).map((r) => ({
    kind: r.kind,
    artist_id: r.artist_id,
    files: Number(r.files),
    bytes: Number(r.bytes),
  }));
  const artistName = new Map(((artistsRes.data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]));

  const vaultUsage = usage.find((r) => r.kind === "vault");
  const normal = usage.filter((r) => r.kind !== "vault");
  const originals = normal.filter((r) => !r.kind.startsWith("derivative:"));
  const derivatives = normal.filter((r) => r.kind.startsWith("derivative:"));
  const totalBytes = normal.reduce((sum, r) => sum + r.bytes, 0);
  const totalFiles = originals.reduce((sum, r) => sum + r.files, 0);
  const price = getPricePerGbMonth();
  const monthlyCost = (totalBytes / BYTES_PER_GB) * price;

  const byKind = new Map<string, { bytes: number; files: number }>();
  for (const r of normal) {
    const current = byKind.get(r.kind) ?? { bytes: 0, files: 0 };
    byKind.set(r.kind, { bytes: current.bytes + r.bytes, files: current.files + r.files });
  }
  const kindRows = [...byKind.entries()]
    .map(([kind, v]) => ({ label: KIND_LABEL[kind] ?? kind, ...v }))
    .sort((a, b) => b.bytes - a.bytes);

  const byArtist = new Map<string, { label: string; bytes: number; files: number }>();
  for (const r of originals) {
    const key = r.artist_id ?? "none";
    const current = byArtist.get(key) ?? {
      label: r.artist_id ? (artistName.get(r.artist_id) ?? "Artista eliminado") : "Sin artista (beats y biblioteca)",
      bytes: 0,
      files: 0,
    };
    byArtist.set(key, { ...current, bytes: current.bytes + r.bytes, files: current.files + r.files });
  }
  const artistRows = [...byArtist.values()].sort((a, b) => b.bytes - a.bytes);
  const originalsBytes = originals.reduce((sum, r) => sum + r.bytes, 0);
  const derivativesBytes = derivatives.reduce((sum, r) => sum + r.bytes, 0);

  return (
    <div className="flex flex-col gap-12">
      <PageHeader
        title="Almacenamiento"
        description="Uso del almacenamiento (Cloudflare R2) por tipo y por artista, y coste mensual estimado."
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumen">
        <Stat label="Uso total" value={formatBytes(totalBytes)} hint={`${formatBytes(originalsBytes)} originales · ${formatBytes(derivativesBytes)} derivados`} />
        <Stat label="Archivos" value={totalFiles.toLocaleString("es-ES")} hint="Listos y no borrados" />
        <Stat
          label="Coste mensual estimado"
          value={money.format(monthlyCost)}
          hint={`${money.format(price)} por GB y mes (R2_PRICE_PER_GB_MONTH)`}
        />
        <Stat label="Unidad de facturación" value="1 GB = 1.000 MB" hint="Estimación: no incluye operaciones ni el tramo gratuito." />
      </section>

      <section>
        <SectionHeader title="Por tipo" />
        <UsageList rows={kindRows} total={totalBytes} />
      </section>

      <section>
        <SectionHeader title="Por artista" />
        <UsageList rows={artistRows} total={originalsBytes} />
      </section>

      {showVault ? (
        <section aria-labelledby="vault-usage">
          <SectionHeader title="Vault" />
          <h3 id="vault-usage" className="sr-only">Uso del Vault</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Uso del Vault" value={formatBytes(vaultUsage?.bytes ?? 0)} hint="Bucket propio, fuera del desglose por artista" />
            <Stat label="Archivos" value={Number(vaultUsage?.files ?? 0).toLocaleString("es-ES")} hint="Listos y no borrados" />
            <Stat
              label="Coste mensual del Vault"
              value={money.format(((vaultUsage?.bytes ?? 0) / BYTES_PER_GB) * price)}
              hint={process.env.R2_BACKUP_BUCKET ? "Con copia de seguridad activada se duplica (solo el Vault)" : "Sin copia de seguridad configurada"}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
