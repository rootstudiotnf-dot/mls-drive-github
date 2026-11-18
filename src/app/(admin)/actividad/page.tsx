import type { Metadata } from "next";
import Link from "next/link";
import { ClockIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { actionText } from "@/lib/activity-labels";
import { requirePagePermission } from "@/lib/permissions/server";
import { isUuid } from "@/lib/storage/keys";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Actividad" };
export const dynamic = "force-dynamic";

const PAGE = 100;
const GROUPS: Record<string, { label: string; prefixes: string[] }> = {
  accesos: { label: "Accesos y enlaces", prefixes: ["grant.", "share.", "artist.member"] },
  usuarios: { label: "Usuarios y roles", prefixes: ["user.", "invitation.", "role."] },
  contenido: { label: "Contenido", prefixes: ["asset.", "upload.", "folder.", "session.", "artist."] },
  beats: { label: "Beats", prefixes: ["beat.", "genre."] },
  comentarios: { label: "Comentarios", prefixes: ["comment."] },
  video: { label: "Vídeo", prefixes: ["video."] },
};
const day = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "Atlantic/Canary" });
const hour = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Atlantic/Canary" });

type Row = { id: string; actor_id: string | null; action: string; metadata: Record<string, unknown> | null; created_at: string };

/**
 * Línea de tiempo de actividad (solo con access.manage). El Vault queda fuera: sus acciones `vault.*` ni se piden aquí
 * ni las devuelve la política de lectura del registro.
 */
export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ tipo?: string; persona?: string; antes?: string }> }) {
  await requirePagePermission("access.manage");
  const query = await searchParams;
  const group = query.tipo && GROUPS[query.tipo] ? query.tipo : null;
  const person = isUuid(query.persona) ? query.persona : null;
  const before = query.antes && !Number.isNaN(Date.parse(query.antes)) ? new Date(query.antes).toISOString() : null;

  const supabase = await createClient();
  let q = supabase.from("activity_log").select("id, actor_id, action, metadata, created_at").not("action", "like", "vault.%");
  if (group) q = q.or((GROUPS[group]?.prefixes ?? []).map((p) => `action.like.${p}%`).join(","));
  if (person) q = q.eq("actor_id", person);
  if (before) q = q.lt("created_at", before);
  const [{ data }, peopleRes] = await Promise.all([q.order("created_at", { ascending: false }).limit(PAGE + 1), supabase.from("profiles").select("id, full_name, email").order("full_name").limit(300)]);

  const rows = (data ?? []) as Row[];
  const more = rows.length > PAGE;
  const shown = rows.slice(0, PAGE);
  const people = (peopleRes.data ?? []) as { id: string; full_name: string | null; email: string }[];
  const nameById = new Map(people.map((p) => [p.id, p.full_name || p.email]));

  const byDay = new Map<string, Row[]>();
  for (const row of shown) {
    const key = day.format(new Date(row.created_at));
    byDay.set(key, [...(byDay.get(key) ?? []), row]);
  }

  const next = new URLSearchParams();
  if (group) next.set("tipo", group);
  if (person) next.set("persona", person);
  if (more) next.set("antes", shown[shown.length - 1]?.created_at ?? "");

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Actividad" description="Qué ha pasado, quién lo ha hecho y cuándo." actions={null} />
      <form method="get" action="/actividad" className="flex flex-wrap items-end gap-3">
        <Select label="Tipo" name="tipo" defaultValue={group ?? ""} options={[{ value: "", label: "Todo" }, ...Object.entries(GROUPS).map(([value, g]) => ({ value, label: g.label }))]} />
        <Select label="Persona" name="persona" defaultValue={person ?? ""} options={[{ value: "", label: "Todas" }, ...people.map((p) => ({ value: p.id, label: p.full_name || p.email }))]} />
        <Button type="submit" size="sm" variant="ghost">
          Filtrar
        </Button>
      </form>

      {shown.length === 0 ? (
        <EmptyState icon={<ClockIcon size={22} />} title="Sin actividad" description="No hay movimientos con estos filtros." />
      ) : (
        <div className="flex flex-col gap-6">
          {[...byDay.entries()].map(([label, items]) => (
            <section key={label} aria-label={label}>
              <h2 className="mb-2 text-label font-medium text-text-2 first-letter:uppercase">{label}</h2>
              <ol className="divide-y divide-line rounded-card border border-line bg-surface">
                {items.map((item) => {
                  const name = item.actor_id ? (nameById.get(item.actor_id) ?? "Alguien") : "Sistema";
                  const meta = item.metadata ?? {};
                  const detail = typeof meta.name === "string" ? meta.name : typeof meta.title === "string" ? meta.title : typeof meta.email === "string" ? meta.email : null;
                  return (
                    <li key={item.id} className="flex items-start gap-3 px-4 py-3.5">
                      <Avatar name={name} size="sm" />
                      <p className="min-w-0 flex-1 text-body text-text">
                        <span className="font-medium">{name}</span> <span className="text-text-2">{actionText(item.action)}</span>
                        {detail ? <span> · {detail}</span> : null}
                      </p>
                      <time dateTime={item.created_at} className="shrink-0 text-caption text-text-3">
                        {hour.format(new Date(item.created_at))}
                      </time>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
      {more ? (
        <Link href={`/actividad?${next.toString()}`} className="self-center rounded-pill border border-line px-4 py-2 text-label text-text-2 transition-colors duration-150 ease-ui hover:border-line-hover hover:text-text">
          Ver más antiguos
        </Link>
      ) : null}
    </div>
  );
}
