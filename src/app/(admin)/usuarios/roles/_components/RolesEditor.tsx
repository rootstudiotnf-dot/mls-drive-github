"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { Toggle } from "@/components/ui/Toggle";
import { cn } from "@/lib/cn";
import {
  ACTION_LABEL,
  ACTIONS,
  ADMIN_PERMISSIONS,
  COMMENT_PERMISSIONS,
  COMMENT_PERMISSION_LABEL,
  ADMIN_PERMISSION_LABEL,
  AREA_LABEL,
  AREAS,
  ROLE_SCOPES,
  SCOPE_LABEL,
  type PermissionKey,
  type RoleScope,
} from "@/lib/permissions/keys";
import { deleteRole, duplicateRole, saveRole } from "../actions";
import { EDIT_STATE_MESSAGE, type RoleView } from "./types";

export type RolesEditorProps = {
  roles: RoleView[];
  selectedKey: string;
  /** Permisos del usuario actual: lo que no tiene no puede concederlo (cosmética; lo impone el servidor). */
  actorPermissions: string[];
  actorScope: RoleScope;
};

const scopeOptions = ROLE_SCOPES.map((value) => ({ value, label: SCOPE_LABEL[value] }));

export function RolesEditor({ roles, selectedKey, actorPermissions, actorScope }: RolesEditorProps) {
  const selected = roles.find((r) => r.key === selectedKey) ?? roles[0];
  if (!selected) return null;

  return (
    <div className="grid gap-8 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-10">
      <nav aria-label="Roles">
        <ul className="flex flex-col gap-1">
          {roles.map((role) => {
            const active = role.key === selected.key;
            return (
              <li key={role.id}>
                <Link
                  href={`/usuarios/roles?role=${encodeURIComponent(role.key)}`}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-card border px-4 py-3",
                    "transition-colors duration-150 ease-ui",
                    active
                      ? "border-line-hover bg-active"
                      : "border-transparent hover:bg-hover",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-body font-medium text-text">{role.name}</span>
                    <span className="block truncate text-caption text-text-2">
                      {role.userCount === 1 ? "1 usuario" : `${role.userCount} usuarios`} · {SCOPE_LABEL[role.scope]}
                    </span>
                  </span>
                  {role.isLocked ? <Badge variant="outline">Bloqueado</Badge> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* key: el editor se reinicia al cambiar de rol */}
      <RoleForm
        key={selected.id}
        role={selected}
        actorPermissions={actorPermissions}
        actorScope={actorScope}
      />
    </div>
  );
}

function RoleForm({
  role,
  actorPermissions,
  actorScope,
}: {
  role: RoleView;
  actorPermissions: string[];
  actorScope: RoleScope;
}) {
  const router = useRouter();
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description);
  const [scope, setScope] = useState<RoleScope>(role.scope);
  const [permissions, setPermissions] = useState<ReadonlySet<string>>(new Set(role.permissions));
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, startTransition] = useTransition();

  const editable = role.editState === "editable";
  const mine = new Set(actorPermissions);

  const dirty =
    name !== role.name ||
    description !== role.description ||
    scope !== role.scope ||
    permissions.size !== role.permissions.length ||
    role.permissions.some((key) => !permissions.has(key));

  const set = (key: string, on: boolean) =>
    setPermissions((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const run = (fn: () => Promise<{ ok: boolean; message?: string; data?: { key: string } }>, after?: (key?: string) => void) =>
    startTransition(async () => {
      const result = await fn();
      setNotice(result.message ? { ok: result.ok, message: result.message } : null);
      if (result.ok) after?.(result.data?.key);
    });

  const canDelete = editable && !role.isSystem && role.userCount === 0;
  const deleteHint = role.isSystem
    ? "Los roles de sistema no se pueden eliminar."
    : role.userCount > 0
      ? "Hay usuarios con este rol."
      : undefined;

  return (
    <section aria-label={`Editor del rol ${role.name}`} className="flex min-w-0 flex-col gap-8">
      {role.editState !== "editable" ? (
        <Notice variant="info">{EDIT_STATE_MESSAGE[role.editState]}</Notice>
      ) : null}
      {notice ? (
        <div aria-live="polite">
          <Notice variant={notice.ok ? "success" : "error"}>{notice.message}</Notice>
        </div>
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          label="Nombre"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          disabled={!editable}
        />
        <Select
          label="Alcance"
          value={scope}
          onChange={(e) => setScope(e.target.value as RoleScope)}
          options={scopeOptions.filter(
            (o) => o.value === scope || actorScope === "all" || o.value === "assigned",
          )}
          disabled={!editable}
        />
        <div className="sm:col-span-2">
          <Textarea
            label="Descripción"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={200}
            disabled={!editable}
          />
        </div>
      </div>

      <div>
        <h2 className="mb-1 text-heading text-text">Permisos de contenido</h2>
        <p className="mb-4 text-label text-text-2">
          El rol fija el máximo; los accesos por artista o recurso solo eligen dónde se aplica.
        </p>
        <div className="rounded-card border border-line bg-surface">
          <table className="w-full table-fixed text-left">
            <caption className="sr-only">Matriz de permisos de {role.name}</caption>
            <thead>
              <tr className="text-caption text-text-3">
                <th scope="col" className="w-24 px-4 py-3 font-medium sm:w-32">
                  Área
                </th>
                {ACTIONS.map((action) => (
                  <th key={action} scope="col" className="px-1 py-3 text-center font-medium">
                    <span className="hidden sm:inline">{ACTION_LABEL[action]}</span>
                    <span className="sm:hidden" aria-hidden="true">
                      {ACTION_LABEL[action].slice(0, 3)}
                    </span>
                    <span className="sr-only sm:hidden">{ACTION_LABEL[action]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {AREAS.map((area) => (
                <tr key={area} className="border-t border-line">
                  <th scope="row" className="px-4 py-3 text-body font-medium text-text">
                    {AREA_LABEL[area]}
                  </th>
                  {ACTIONS.map((action) => {
                    const key = `${area}.${action}`;
                    return (
                      <td key={action} className="px-1 py-3 text-center">
                        <Toggle
                          label={`${AREA_LABEL[area]}: ${ACTION_LABEL[action]}`}
                          checked={permissions.has(key)}
                          onChange={(on) => set(key, on)}
                          disabled={!editable || (!mine.has(key) && !permissions.has(key))}
                          className="mx-auto"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-heading text-text">Comentarios</h2>
        <div className="divide-y divide-line rounded-card border border-line bg-surface">
          {COMMENT_PERMISSIONS.map((key) => (
            <div key={key} className="flex items-center justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0">
                <p className="text-body font-medium text-text">{COMMENT_PERMISSION_LABEL[key].label}</p>
                <p className="text-label text-text-2">{COMMENT_PERMISSION_LABEL[key].hint}</p>
              </div>
              <Toggle
                label={COMMENT_PERMISSION_LABEL[key].label}
                checked={permissions.has(key)}
                onChange={(on) => set(key, on)}
                disabled={!editable || (!mine.has(key) && !permissions.has(key))}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-heading text-text">Administración</h2>
        <div className="divide-y divide-line rounded-card border border-line bg-surface">
          {ADMIN_PERMISSIONS.map((key) => (
            <div key={key} className="flex items-center justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0">
                <p className="text-body font-medium text-text">{ADMIN_PERMISSION_LABEL[key].label}</p>
                <p className="text-label text-text-2">{ADMIN_PERMISSION_LABEL[key].hint}</p>
              </div>
              <Toggle
                label={ADMIN_PERMISSION_LABEL[key].label}
                checked={permissions.has(key)}
                onChange={(on) => set(key, on)}
                disabled={!editable || (!mine.has(key) && !permissions.has(key))}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-6">
        <Button
          disabled={!editable || !dirty || pending}
          onClick={() =>
            run(() =>
              saveRole(role.id, {
                name,
                description,
                scope,
                permissions: [...permissions] as PermissionKey[],
              }),
            )
          }
        >
          {pending ? "Guardando…" : "Guardar cambios"}
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() =>
            run(
              () => duplicateRole(role.id),
              (key) => key && router.push(`/usuarios/roles?role=${encodeURIComponent(key)}`),
            )
          }
        >
          Duplicar
        </Button>
        <Button
          variant="ghost"
          disabled={!canDelete || pending}
          title={deleteHint}
          onClick={() => setConfirmDelete(true)}
          className="sm:ml-auto"
        >
          Eliminar
        </Button>
        {dirty && editable ? (
          <p className="w-full text-caption text-text-3">Tienes cambios sin guardar.</p>
        ) : null}
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Eliminar rol"
        description={`«${role.name}» se eliminará para siempre. Esta acción no se puede deshacer.`}
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
            Cancelar
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              setConfirmDelete(false);
              run(
                () => deleteRole(role.id),
                () => router.push("/usuarios/roles"),
              );
            }}
          >
            Eliminar rol
          </Button>
        </div>
      </Modal>
    </section>
  );
}
