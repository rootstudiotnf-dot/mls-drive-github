import { cn } from "@/lib/cn";

export type ProgressProps = {
  /** 0..1 */
  value: number;
  /** Texto accesible (obligatorio: la barra no tiene texto visible). */
  label: string;
  className?: string;
};

export function Progress({ value, label, className }: ProgressProps) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn("h-1.5 w-full overflow-hidden rounded-pill bg-tone-4", className)}
    >
      <div
        className="h-full rounded-pill bg-text transition-[width] duration-200 ease-ui"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
