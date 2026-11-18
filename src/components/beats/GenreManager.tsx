"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createGenre, deleteGenre, mergeGenres, renameGenre } from "@/app/actions/beats";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { MusicIcon } from "@/components/icons";

type Genre = { id: string; name: string; beats: number };

/**
 * Gestión de géneros: crear, renombrar, fusionar (los beats del género de origen pasan al destino) y borrar los que
 * no se usan. Los géneros que sí tienen beats no se pueden borrar sin fusionarlos antes: ningún beat se queda sin dato.
 */
export function GenreManager({ genres }: { genres: Genre[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [name, setName] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, done?: () => void) =>
    startTransition(async () => {
      const res = await fn();
      setMessage({ kind: res.ok ? "success" : "error", text: res.message ?? (res.ok ? "Hecho." : "No se pudo completar la acción.") });
      if (res.ok) {
        done?.();
        router.refresh();
      }
    });

  return (
    <div className="flex flex-col gap-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(() => createGenre(name), () => setName(""));
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <Input label="Nuevo género" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className="w-64" />
        <Button type="submit" disabled={pending || !name.trim()}>
          Crear
        </Button>
      </form>

      {message ? <Notice variant={message.kind}>{message.text}</Notice> : null}

      {genres.length === 0 ? (
        <EmptyState icon={<MusicIcon size={22} />} title="Todavía no hay géneros" description="Créalos aquí o al editar un beat." />
      ) : (
        <ul className="flex flex-col gap-3">
          {genres.map((g) => {
            const draft = names[g.id] ?? g.name;
            const target = targets[g.id] ?? "";
            return (
              <li key={g.id} className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4 lg:flex-row lg:items-end">
                <div className="flex items-end gap-2">
                  <Input label={`Nombre (${g.beats} ${g.beats === 1 ? "beat" : "beats"})`} value={draft} maxLength={40} onChange={(e) => setNames({ ...names, [g.id]: e.target.value })} className="w-56" />
                  <Button variant="ghost" disabled={pending || !draft.trim() || draft.trim() === g.name} onClick={() => run(() => renameGenre(g.id, draft))}>
                    Renombrar
                  </Button>
                </div>
                <div className="flex items-end gap-2 lg:ml-auto">
                  <div className="w-52">
                    <Select
                      label="Fusionar en…"
                      value={target}
                      onChange={(e) => setTargets({ ...targets, [g.id]: e.target.value })}
                      options={[{ value: "", label: "Elige el destino" }, ...genres.filter((o) => o.id !== g.id).map((o) => ({ value: o.id, label: o.name }))]}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    disabled={pending || !target}
                    onClick={() => {
                      if (window.confirm(`Los ${g.beats} beats de «${g.name}» pasarán al género elegido y «${g.name}» se eliminará. ¿Continuar?`)) run(() => mergeGenres(g.id, target));
                    }}
                  >
                    Fusionar
                  </Button>
                  <Button variant="ghost" disabled={pending || g.beats > 0} title={g.beats > 0 ? "Tiene beats: fusiónalo antes" : undefined} onClick={() => run(() => deleteGenre(g.id))}>
                    Borrar
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
