"use client";

import { useState, useTransition } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select } from "@/components/ui/Select";
import { FolderIcon } from "@/components/icons";
import type { ActionResult } from "@/lib/action-result";
import { assignMember, unassignMember } from "../actions";
import type { ArtistAssignment, Option } from "./types";

function ArtistCard({
  artist,
  recipients,
  pending,
  run,
}: {
  artist: ArtistAssignment;
  recipients: Option[];
  pending: boolean;
  run: (fn: () => Promise<ActionResult>) => void;
}) {
  const assigned = new Set(artist.members.map((m) => m.userId));
  const available = recipients.filter((r) => !assigned.has(r.value));
  const [userId, setUserId] = useState("");

  return (
    <li className="rounded-card border border-line bg-surface p-5">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-tone-3 text-text-2">
          <FolderIcon size={20} />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-body font-medium text-text">{artist.name}</h3>
          <p className="text-label text-text-2">
            {artist.members.length === 0
              ? "Sin personas asignadas"
              : artist.members.length === 1
                ? "1 persona asignada"
                : `${artist.members.length} personas asignadas`}
          </p>
        </div>
      </div>

      {artist.members.length > 0 ? (
        <ul className="mt-4 flex flex-wrap gap-2">
          {artist.members.map((member) => (
            <li
              key={member.memberId}
              className="flex items-center gap-2 rounded-pill border border-line py-1 pr-1.5 pl-1"
            >
              <Avatar name={member.name} size="sm" />
              <span className="text-label text-text">{member.name}</span>
              <button
                type="button"
                aria-label={`Quitar a ${member.name} de ${artist.name}`}
                disabled={pending}
                onClick={() => run(() => unassignMember(member.memberId))}
                className="flex size-5 items-center justify-center rounded-pill text-text-3 transition-colors duration-150 ease-ui hover:bg-active hover:text-text disabled:opacity-40"
              >
                <span aria-hidden="true" className="text-body leading-none">
                  ×
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {available.length > 0 ? (
        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!userId) return;
            run(() => assignMember(artist.id, userId));
            setUserId("");
          }}
        >
          <div className="min-w-0 flex-1">
            <Select
              label="Asignar persona"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              options={[{ value: "", label: "Elige una persona…" }, ...available]}
            />
          </div>
          <Button type="submit" variant="ghost" disabled={!userId || pending}>
            Asignar
          </Button>
        </form>
      ) : null}
    </li>
  );
}

export function Assignments({
  assignments,
  recipients,
}: {
  assignments: ArtistAssignment[];
  recipients: Option[];
}) {
  const [notice, setNotice] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<ActionResult>) =>
    startTransition(async () => setNotice(await fn()));

  return (
    <section>
      <SectionHeader title="Asignaciones por artista" />
      <p className="-mt-3 mb-5 max-w-2xl text-label text-text-2">
        Los roles con alcance «solo artistas asignados» ven únicamente el contenido de los artistas a los
        que están asignados.
      </p>
      <div aria-live="polite" className="mb-4 empty:hidden">
        {notice ? (
          <Notice variant={notice.ok ? "success" : "error"}>{notice.message ?? "Hecho."}</Notice>
        ) : null}
      </div>
      {assignments.length === 0 ? (
        <EmptyState
          icon={<FolderIcon size={22} />}
          title="Aún no hay artistas"
          description="Cuando existan artistas podrás asignarles personas aquí."
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {assignments.map((artist) => (
            <ArtistCard
              key={artist.id}
              artist={artist}
              recipients={recipients}
              pending={pending}
              run={run}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
