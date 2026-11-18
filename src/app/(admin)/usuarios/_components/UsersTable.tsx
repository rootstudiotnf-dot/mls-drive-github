"use client";

import { useState, useTransition } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Select";
import {
  changeUserRole,
  resendInvitation,
  revokeInvitation,
  setUserStatus,
  type ActionResult,
} from "../actions";
import { STATE_LABEL, type RoleOption, type UserRow } from "./types";

type Dialog =
  | { kind: "role"; row: UserRow }
  | { kind: "disable"; row: UserRow }
  | { kind: "revoke"; row: UserRow };

export type UsersTableProps = {
  rows: UserRow[];
  actorId: string;
  /** Claves de los roles que el usuario actual puede gestionar (rango menor). Solo cosmética. */
  manageableRoleKeys: string[];
  /** Roles que el usuario actual puede asignar. */
  roleOptions: RoleOption[];
};

const label = (row: UserRow) => row.name ?? row.email;

export function UsersTable({ rows, actorId, manageableRoleKeys, roleOptions }: UsersTableProps) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<ActionResult | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const closeDialog = () => {
    setDialog(null);
    setDialogError(null);
  };

  /** Ejecuta una acción de servidor; los errores salen en el diálogo si hay uno abierto. */
  const run = (action: () => Promise<ActionResult>) => {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setNotice(result);
        closeDialog();
      } else if (dialog) {
        setDialogError(result.message);
      } else {
        setNotice(result);
      }
    });
  };

  // La interfaz solo oculta lo que no procede; el servidor vuelve a comprobarlo todo.
  const menuFor = (row: UserRow): MenuItem[] => {
    if (row.id === actorId || !manageableRoleKeys.includes(row.roleKey)) return [];
    const changeRole: MenuItem = {
      label: "Cambiar rol",
      onSelect: () => setDialog({ kind: "role", row }),
    };
    switch (row.state) {
      case "active":
        return [
          changeRole,
          { label: "Desactivar", destructive: true, onSelect: () => setDialog({ kind: "disable", row }) },
        ];
      case "disabled":
        return [
          { label: "Reactivar", onSelect: () => run(() => setUserStatus(row.id, "active")) },
          changeRole,
        ];
      case "invited":
      case "expired":
        return [
          {
            label: "Reenviar invitación",
            onSelect: () => row.invitationId && run(() => resendInvitation(row.invitationId!)),
          },
          { label: "Revocar invitación", destructive: true, onSelect: () => setDialog({ kind: "revoke", row }) },
        ];
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div aria-live="polite">
        {notice ? (
          <Notice variant={notice.ok ? "success" : "error"}>
            {notice.message ?? "Hecho."}
          </Notice>
        ) : null}
      </div>

      <div className="rounded-card border border-line bg-surface">
        <table className="w-full table-fixed text-left">
          <caption className="sr-only">Usuarios de la plataforma</caption>
          <thead className="hidden md:table-header-group">
            <tr className="text-caption text-text-3">
              <th scope="col" className="px-4 py-3 font-medium">Usuario</th>
              <th scope="col" className="w-36 px-4 py-3 font-medium">Rol</th>
              <th scope="col" className="w-48 px-4 py-3 font-medium">Estado</th>
              <th scope="col" className="hidden w-44 px-4 py-3 font-medium lg:table-cell">Último acceso</th>
              <th scope="col" className="w-16 px-4 py-3"><span className="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const items = menuFor(row);
              return (
                <tr key={row.id} className="border-t border-line align-middle">
                  <td className="px-4 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar name={label(row)} />
                      <div className="min-w-0">
                        <p className="truncate text-body font-medium text-text">{label(row)}</p>
                        <p className="truncate text-label text-text-2">{row.email}</p>
                        <p className="mt-1 flex flex-wrap gap-1.5 md:hidden">
                          <Badge variant="neutral">{row.roleName}</Badge>
                          <Badge variant={row.state === "active" ? "neutral" : "outline"}>
                            {STATE_LABEL[row.state]}
                          </Badge>
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 text-body text-text-2 md:table-cell">
                    {row.roleName}
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    <Badge variant={row.state === "active" ? "neutral" : "outline"}>
                      {STATE_LABEL[row.state]}
                    </Badge>
                  </td>
                  <td className="hidden px-4 py-3 text-label text-text-2 lg:table-cell">
                    {row.lastSeenLabel}
                  </td>
                  <td className="w-16 px-4 py-3 text-right">
                    {items.length > 0 ? (
                      <Menu
                        label={`Acciones para ${label(row)}`}
                        items={items}
                        className="flex justify-end"
                      />
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Modal
        open={dialog?.kind === "role"}
        onClose={closeDialog}
        title="Cambiar rol"
        description={dialog ? `Nuevo rol para ${label(dialog.row)}.` : undefined}
      >
        {dialog?.kind === "role" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const role = new FormData(event.currentTarget).get("role");
              if (typeof role === "string") run(() => changeUserRole(dialog.row.id, role));
            }}
          >
            {dialogError ? <Notice variant="error">{dialogError}</Notice> : null}
            <Select
              label="Rol"
              name="role"
              options={roleOptions}
              defaultValue={
                roleOptions.some((o) => o.value === dialog.row.roleKey)
                  ? dialog.row.roleKey
                  : roleOptions[0]?.value
              }
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={closeDialog}>
                Cancelar
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Guardando…" : "Guardar"}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={dialog?.kind === "disable"}
        onClose={closeDialog}
        title="Desactivar usuario"
        description={
          dialog
            ? `${label(dialog.row)} perderá el acceso de inmediato. Podrás reactivarlo cuando quieras.`
            : undefined
        }
      >
        {dialog?.kind === "disable" ? (
          <div className="flex flex-col gap-4">
            {dialogError ? <Notice variant="error">{dialogError}</Notice> : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeDialog}>Cancelar</Button>
              <Button disabled={pending} onClick={() => run(() => setUserStatus(dialog.row.id, "disabled"))}>
                {pending ? "Desactivando…" : "Desactivar"}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={dialog?.kind === "revoke"}
        onClose={closeDialog}
        title="Revocar invitación"
        description={
          dialog
            ? `El enlace enviado a ${dialog.row.email} dejará de funcionar. Esta acción no se puede deshacer, pero podrás invitar de nuevo.`
            : undefined
        }
      >
        {dialog?.kind === "revoke" ? (
          <div className="flex flex-col gap-4">
            {dialogError ? <Notice variant="error">{dialogError}</Notice> : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeDialog}>Cancelar</Button>
              <Button
                disabled={pending}
                onClick={() => dialog.row.invitationId && run(() => revokeInvitation(dialog.row.invitationId!))}
              >
                {pending ? "Revocando…" : "Revocar"}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
