"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { inviteToArtist } from "@/app/actions/artists";
import { assignMember, createGrant, revokeGrant, unassignMember, updateGrant } from "@/app/(admin)/accesos/actions";
import { KeyIcon, PlusIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DataList, DataRow } from "@/components/ui/DataRow";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import type { ActionResult } from "@/lib/action-result";

export type AccessMember = { memberId: string; userId: string; name: string; roleName: string };

export type AccessGrant = {
  id: string;
  userId: string;
  name: string;
  email: string;
  roleName: string;
  canView: boolean;
  canDownload: boolean;
  canUpload: boolean;
  canEdit: boolean;
  /** YYYY-MM-DD o null */
  expiresOn: string | null;
  expiresLabel: string | null;
  state: "active" | "expired";
};

type Option = { value: string; label: string };

type Dialog =
  | { type: "add" }
  | { type: "assign" }
  | { type: "invite" }
  | { type: "edit"; grant: AccessGrant }
  | { type: "revoke"; grant: AccessGrant };

const flagsText = (g: Pick<AccessGrant, "canView" | "canDownload" | "canUpload" | "canEdit">) =>
  [g.canView && "Ver", g.canDownload && "Descargar", g.canUpload && "Subir", g.canEdit && "Editar"].filter(Boolean).join(" · ");

function FlagToggles({
  value,
  onChange,
  allowUpload = true,
}: {
  allowUpload?: boolean;
  value: { canDownload: boolean; canUpload: boolean; canEdit?: boolean };
  onChange: (next: { canDownload: boolean; canUpload: boolean; canEdit?: boolean }) => void;
}) {
  const rows = [
    ["Descargar", "canDownload"],
    ...(allowUpload ? [["Subir", "canUpload"] as const] : []),
    ...(value.canEdit !== undefined ? [["Editar", "canEdit"] as const] : []),
  ] as const;
  return (
    <fieldset>
      <legend className="mb-2 text-label font-medium text-text-2">Puede además</legend>
      <div className="grid grid-cols-2 gap-3">
        {rows.map(([name, key]) => (
          <label key={key} className="flex items-center justify-between gap-2.5 rounded-control border border-line px-3 py-2 text-body text-text">
            <Toggle label={name} checked={Boolean(value[key])} onChange={(checked) => onChange({ ...value, [key]: checked })} />
            {name}
          </label>
        ))}
      </div>
      <p className="mt-2 text-caption text-text-3">Siempre puede ver. Nunca supera lo que permite su rol.</p>
    </fieldset>
  );
}

/**
 * Accesos del artista: equipo permanente (asignaciones), accesos concedidos con permisos y caducidad, y la
 * invitación de alguien nuevo. Todo se comprueba de nuevo en servidor (access.manage + anti-escalada).
 */
export function AccessPanel({
  artistId,
  resourceType = "artist",
  showTeam = true,
  allowUpload = true,
  members,
  grants,
  recipients,
  roles,
  canInvite,
}: {
  /** Id del recurso al que se da acceso (el artista, o la sesión si `resourceType` es "session"). */
  artistId: string;
  resourceType?: "artist" | "session";
  /** Equipo asignado al artista (no aplica a una sesión). */
  showTeam?: boolean;
  /** Permiso «Subir» en los accesos (en una sesión se ofrece solo ver y descargar). */
  allowUpload?: boolean;
  members: AccessMember[];
  grants: AccessGrant[];
  /** Personas existentes a las que se puede dar acceso. */
  recipients: Option[];
  /** Roles que quien invita puede asignar (rango estrictamente menor). */
  roles: Option[];
  canInvite: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<ActionResult<unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Campos de los formularios
  const [userId, setUserId] = useState("");
  const [assignUser, setAssignUser] = useState("");
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState("");
  const [flags, setFlags] = useState<{ canDownload: boolean; canUpload: boolean; canEdit?: boolean }>({ canDownload: false, canUpload: false });
  const [expiresOn, setExpiresOn] = useState("");

  const assigned = new Set(members.map((m) => m.userId));
  const granted = new Set(grants.filter((g) => g.state === "active").map((g) => g.userId));

  const open = (next: Dialog) => {
    setError(null);
    setNotice(null);
    setUserId(recipients.find((r) => !granted.has(r.value))?.value ?? "");
    setAssignUser(recipients.find((r) => !assigned.has(r.value))?.value ?? "");
    setEmail("");
    setRoleKey(roles[0]?.value ?? "");
    setExpiresOn(next.type === "edit" ? (next.grant.expiresOn ?? "") : "");
    setFlags(
      next.type === "edit"
        ? { canDownload: next.grant.canDownload, canUpload: next.grant.canUpload, canEdit: next.grant.canEdit }
        : next.type === "add"
          ? { canDownload: false, canUpload: false, canEdit: false }
          : { canDownload: false, canUpload: false },
    );
    setDialog(next);
  };

  const run = (fn: () => Promise<ActionResult<unknown>>, closeOnSuccess = true) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        setNotice(result);
        if (closeOnSuccess) setDialog(null);
        router.refresh();
      } else if (dialog) setError(result.message);
      else setNotice(result);
    });

  const addable = recipients.filter((r) => !granted.has(r.value));
  const assignable = recipients.filter((r) => !assigned.has(r.value));

  return (
    <section className="flex flex-col gap-10" aria-label="Accesos">
      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice variant={notice.ok ? "success" : "error"}>{notice.message ?? "Hecho."}</Notice> : null}
      </div>

      {showTeam ? (
      <div>
        <SectionHeader
          title="Equipo del artista"
          action={
            <Button size="sm" variant="ghost" disabled={assignable.length === 0} onClick={() => open({ type: "assign" })}>
              <PlusIcon size={16} />
              Asignar persona
            </Button>
          }
        />
        <p className="-mt-3 mb-4 max-w-2xl text-label text-text-2">
          Las personas asignadas ven este espacio de forma permanente, dentro de lo que permite su rol.
        </p>
        {members.length === 0 ? (
          <p className="text-label text-text-3">Nadie asignado todavía.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {members.map((member) => (
              <li key={member.memberId} className="flex items-center gap-2 rounded-pill border border-line py-1 pr-1.5 pl-1">
                <Avatar name={member.name} size="sm" />
                <span className="text-label text-text">{member.name}</span>
                <span className="text-caption text-text-3">{member.roleName}</span>
                <button
                  type="button"
                  aria-label={`Quitar a ${member.name} del equipo`}
                  disabled={pending}
                  onClick={() => run(() => unassignMember(member.memberId), false)}
                  className="flex size-5 items-center justify-center rounded-pill text-text-3 transition-colors duration-150 ease-ui hover:bg-active hover:text-text disabled:opacity-40"
                >
                  <span aria-hidden="true" className="text-body leading-none">
                    ×
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      ) : null}

      <div>
        <SectionHeader title="Accesos concedidos" className="mb-3" />
        <div className="mb-4 flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={addable.length === 0} onClick={() => open({ type: "add" })}>
            <PlusIcon size={16} />
            Dar acceso
          </Button>
          {canInvite ? (
            <Button size="sm" disabled={roles.length === 0} onClick={() => open({ type: "invite" })}>
              <PlusIcon size={16} />
              Invitar a alguien
            </Button>
          ) : null}
        </div>
        {grants.length === 0 ? (
          <EmptyState
            icon={<KeyIcon size={22} />}
            title="Sin accesos concedidos"
            description="Da acceso a una persona de tu equipo o invita a alguien nuevo: elige qué puede hacer y hasta cuándo."
          />
        ) : (
          <DataList>
            {grants.map((grant) => (
              <DataRow
                key={grant.id}
                leading={<Avatar name={grant.name} size="md" />}
                title={grant.name}
                subtitle={`${grant.roleName} · ${flagsText(grant)}${grant.expiresLabel ? ` · caduca el ${grant.expiresLabel}` : ""}`}
                trailing={
                  <>
                    {grant.state === "expired" ? <Badge variant="outline">Caducado</Badge> : null}
                    <Button size="sm" variant="ghost" aria-label={`Editar el acceso de ${grant.name}`} onClick={() => open({ type: "edit", grant })}>
                      Editar
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Revocar el acceso de ${grant.name}`} onClick={() => open({ type: "revoke", grant })}>
                      Revocar
                    </Button>
                  </>
                }
              />
            ))}
          </DataList>
        )}
      </div>

      {/* Dar acceso a una persona existente */}
      <Modal open={dialog?.type === "add"} onClose={() => setDialog(null)} title="Dar acceso" description="Solo ve este artista, y nunca más de lo que permite su rol.">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => createGrant({ userId, resourceType, resourceId: artistId, canView: true, ...flags, canEdit: flags.canEdit === true, expiresOn: expiresOn || null }));
          }}
        >
          {error ? <Notice variant="error">{error}</Notice> : null}
          <Select label="Persona" value={userId} onChange={(e) => setUserId(e.target.value)} options={addable.length > 0 ? addable : [{ value: "", label: "No hay personas disponibles" }]} />
          <FlagToggles value={flags} onChange={setFlags} allowUpload={allowUpload} />
          <Input label="Caduca el (opcional)" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending || !userId}>
              {pending ? "Guardando…" : "Dar acceso"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Asignar al equipo (permanente) */}
      <Modal open={dialog?.type === "assign"} onClose={() => setDialog(null)} title="Asignar persona" description="Pasa a formar parte del equipo del artista, dentro de lo que permite su rol.">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => assignMember(artistId, assignUser));
          }}
        >
          {error ? <Notice variant="error">{error}</Notice> : null}
          <Select label="Persona" value={assignUser} onChange={(e) => setAssignUser(e.target.value)} options={assignable.length > 0 ? assignable : [{ value: "", label: "No hay personas disponibles" }]} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending || !assignUser}>
              {pending ? "Guardando…" : "Asignar"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Invitar a alguien nuevo */}
      <Modal open={dialog?.type === "invite"} onClose={() => setDialog(null)} title="Invitar a alguien" description="Recibirá un correo; tendrá acceso a este artista cuando acepte.">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => inviteToArtist({ artistId, email, roleKey, canDownload: flags.canDownload, canUpload: flags.canUpload, expiresOn: expiresOn || null }));
          }}
        >
          {error ? <Notice variant="error">{error}</Notice> : null}
          <Input label="Correo" type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="persona@correo.com" required autoFocus />
          <Select label="Rol" value={roleKey} onChange={(e) => setRoleKey(e.target.value)} options={roles} />
          <FlagToggles value={flags} onChange={setFlags} allowUpload={allowUpload} />
          <Input label="Caduca el (opcional)" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending || !email.includes("@") || !roleKey}>
              {pending ? "Enviando…" : "Enviar invitación"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Editar un acceso */}
      <Modal open={dialog?.type === "edit"} onClose={() => setDialog(null)} title="Editar acceso" description={dialog?.type === "edit" ? dialog.grant.name : undefined}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (dialog?.type !== "edit") return;
            const id = dialog.grant.id;
            run(() => updateGrant(id, { canView: true, ...flags, canEdit: flags.canEdit === true, expiresOn: expiresOn || null }));
          }}
        >
          {error ? <Notice variant="error">{error}</Notice> : null}
          <FlagToggles value={flags} onChange={setFlags} allowUpload={allowUpload} />
          <Input label="Caduca el (opcional)" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending}>
              Guardar
            </Button>
          </div>
        </form>
      </Modal>

      {/* Revocar */}
      <Modal
        open={dialog?.type === "revoke"}
        onClose={() => setDialog(null)}
        title="Revocar acceso"
        description={dialog?.type === "revoke" ? `${dialog.grant.name} dejará de ver este espacio de inmediato. Podrás darle acceso de nuevo.` : undefined}
      >
        {error ? <Notice variant="error">{error}</Notice> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Cancelar
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              if (dialog?.type !== "revoke") return;
              const id = dialog.grant.id;
              run(() => revokeGrant(id));
            }}
          >
            Revocar
          </Button>
        </div>
      </Modal>
    </section>
  );
}

