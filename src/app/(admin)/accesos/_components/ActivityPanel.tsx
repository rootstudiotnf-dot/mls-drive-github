import { Avatar } from "@/components/ui/Avatar";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { ShieldIcon } from "@/components/icons";
import { actionText } from "@/lib/activity-labels";

export type ActivityItem = {
  id: string;
  actorName: string;
  action: string;
  detail: string | null;
  whenLabel: string;
};

/** Actividad reciente (roles, accesos, usuarios y publicaciones). Solo lectura. */
export function ActivityPanel({ items }: { items: ActivityItem[] }) {
  return (
    <section>
      <SectionHeader title="Actividad reciente" />
      {items.length === 0 ? (
        <EmptyState
          icon={<ShieldIcon size={22} />}
          title="Sin actividad todavía"
          description="Aquí aparecerán los cambios de roles, accesos, usuarios y publicaciones."
        />
      ) : (
        <ol className="divide-y divide-line rounded-card border border-line bg-surface">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 px-4 py-3.5">
              <Avatar name={item.actorName} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-body text-text">
                  <span className="font-medium">{item.actorName}</span>{" "}
                  <span className="text-text-2">{actionText(item.action)}</span>
                  {item.detail ? <span className="text-text"> · {item.detail}</span> : null}
                </p>
              </div>
              <time className="shrink-0 text-caption text-text-3">{item.whenLabel}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
