"use client";

import { useEffect, useState } from "react";
import { exportVaultLogCsv, listVaultLog, type VaultLogEntry, type VaultLogFilters, type VaultLogPage } from "@/app/actions/vault";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { LockIcon } from "@/components/icons";
import { VAULT_ACTIONS, VAULT_ACTION_LABEL } from "@/lib/vault/labels";
import { VaultKeepAlive } from "./VaultKeepAlive";

const when = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Atlantic/Canary" });

/** Registro completo del Vault (solo owner): filtros por persona, acción, carpeta y fecha; paginado; exportable a CSV. */
export function VaultLogView() {
  const [filters, setFilters] = useState<VaultLogFilters>({});
  const [meta, setMeta] = useState<Pick<VaultLogPage, "people" | "folders"> | null>(null);
  const [items, setItems] = useState<VaultLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listVaultLog({ filters }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok || !res.data) return setError("No se pudo cargar el registro.");
      setError(null);
      setItems(res.data.items);
      setCursor(res.data.nextCursor);
      setMeta({ people: res.data.people, folders: res.data.folders });
    });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const set = (changes: Partial<VaultLogFilters>) => {
    setLoading(true);
    setFilters((current) => {
      const next = { ...current, ...changes };
      for (const key of Object.keys(next) as (keyof VaultLogFilters)[]) if (!next[key]) delete next[key];
      return next;
    });
  };

  const more = () => {
    setLoading(true);
    void listVaultLog({ filters, cursor }).then((res) => {
      setLoading(false);
      if (res.ok && res.data) {
        setItems((current) => [...current, ...res.data!.items]);
        setCursor(res.data.nextCursor);
      }
    });
  };

  const exportCsv = async () => {
    setExporting(true);
    const res = await exportVaultLogCsv(filters);
    setExporting(false);
    if (!res.ok || !res.data) return setError("No se pudo exportar.");
    const blob = new Blob(["﻿", res.data.csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `registro-vault-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  return (
    <div className="flex flex-col gap-6">
      <VaultKeepAlive />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Select label="Persona" value={filters.actorId ?? ""} onChange={(e) => set({ actorId: e.target.value })} options={[{ value: "", label: "Todas" }, ...(meta?.people ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
        <Select label="Acción" value={filters.action ?? ""} onChange={(e) => set({ action: e.target.value })} options={[{ value: "", label: "Todas" }, ...VAULT_ACTIONS.map((a) => ({ value: a, label: VAULT_ACTION_LABEL[a] ?? a }))]} />
        <Select label="Carpeta" value={filters.folderId ?? ""} onChange={(e) => set({ folderId: e.target.value })} options={[{ value: "", label: "Todas" }, ...(meta?.folders ?? []).map((f) => ({ value: f.id, label: f.name }))]} />
        <Input label="Desde" type="date" value={filters.from ?? ""} onChange={(e) => set({ from: e.target.value })} />
        <Input label="Hasta" type="date" value={filters.to ?? ""} onChange={(e) => set({ to: e.target.value })} />
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" disabled={exporting} onClick={() => void exportCsv()}>
          {exporting ? "Exportando…" : "Exportar a CSV"}
        </Button>
      </div>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {items.length === 0 && !loading ? (
        <EmptyState icon={<LockIcon size={22} />} title="Sin eventos" description="No hay eventos con esos filtros." />
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface">
          {items.map((e) => (
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
      )}
      {cursor ? (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" disabled={loading} onClick={more}>
            Cargar más
          </Button>
        </div>
      ) : null}
    </div>
  );
}
