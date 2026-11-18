"use client";

import { useState, useTransition } from "react";
import { CheckIcon, KeyIcon, PlusIcon } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select } from "@/components/ui/Select";
import type { ActionResult } from "@/lib/action-result";
import { RESOURCE_TYPES, type ResourceType } from "@/lib/permissions/keys";
import { createGrant, revokeGrant, updateGrant } from "../actions";
import { GRANT_STATE_LABEL, RESOURCE_LABEL, type GrantRow, type Option } from "./types";

type ResourceOptions = Record<Exclude<ResourceType, "vault">, Option[]>;

type Editing = { mode: "create" } | { mode: "edit"; grant: GrantRow };

function flagsText(g: GrantRow): string {
  const parts = [
    g.canView && "Ver",
    g.canDownload && "Descargar",
    g.canUpload && "Subir",
    g.canEdit && "Editar",
  ].filter(Boolean);
  return parts.join(" · ");
}

function GrantForm({
  editing,
  recipients,
  resourceOptions,
  onClose,
  onDone,
}: {
  editing: Editing;
  recipients: Option[];
  resourceOptions: ResourceOptions;
  onClose: () => void;
  onDone: (result: ActionResult) => void;
}) {
  const grant = editing.mode === "edit" ? editing.grant : null;
  const [userId, setUserId] = useState(recipients[0]?.value ?? "");
  const [type, setType] = useState<ResourceType>("artist");
  const [resourceId, setResourceId] = useState("");
  const [canView, setCanView] = useState(grant?.canView ?? true);
  const [canDownload, setCanDownload] = useState(grant?.canDownload ?? false);
  const [canUpload, setCanUpload] = useState(grant?.canUpload ?? false);
  const [canEdit, setCanEdit] = useState(grant?.canEdit ?? false);
  const [expiresOn, setExpiresOn] = useState(grant?.expiresOn ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const options = type === "vault" ? [] : resourceOptions[type];

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const flags = { canView, canDownload, canUpload, canEdit, expiresOn: expiresOn || null };
      const result = grant
        ? await updateGrant(grant.id, flags)
        : await createGrant({
            userId,
            resourceType: type,
            resourceId: type === "vault" ? null : resourceId,
            ...flags,
          });
      if (result.ok) onDone(result);
      else setError(result.message);
    });
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {error ? <Notice variant="error">{error}</Notice> : null}

      {grant ? (
        <div className="rounded-control border border-line bg-tone-1 px-3.5 py-3 text-label text-text-2">
          <span className="text-text">{grant.userName}</span> · {RESOURCE_LABEL[grant.resourceType]}:{" "}
          {grant.resourceLabel}
        </div>
      ) : (
        <>
          <Select
            label="Persona"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            options={recipients.length > 0 ? recipients : [{ value: "", label: "No hay personas disponibles" }]}
          />
          <Select
            label="Tipo de recurso"
            value={type}
            onChange={(e) => {
              setType(e.target.value as ResourceType);
              setResourceId("");
            }}
            options={RESOURCE_TYPES.filter((t) => t !== "vault").map((t) => ({ value: t, label: RESOURCE_LABEL[t] }))}
          />
          {type === "vault" ? (
            <Notice variant="info">
              El Vault no hereda permisos de artistas ni sesiones: este acceso se concede de forma
              explícita y solo sirve si el rol de la persona tiene permisos de Vault.
            </Notice>
          ) : (
            <Select
              label={RESOURCE_LABEL[type]}
              value={resourceId}
              onChange={(e) => setResourceId(e.target.value)}
              options={[
                { value: "", label: options.length > 0 ? "Elige…" : "No hay recursos de este tipo" },
                ...options,
              ]}
            />
          )}
        </>
      )}

      <fieldset>
        <legend className="mb-2 text-label font-medium text-text-2">Permisos</legend>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ["Ver", canView, setCanView],
              ["Descargar", canDownload, setCanDownload],
              ["Subir", canUpload, setCanUpload],
              ["Editar", canEdit, setCanEdit],
            ] as const
          ).map(([name, value, setter]) => (
            <label key={name} className="flex items-center justify-between gap-2.5 rounded-control border border-line px-3 py-2 text-body text-text">
              <Toggle label={name} checked={value} onChange={setter} />
              {name}
            </label>
          ))}
        </div>
        <p className="mt-2 text-caption text-text-3">
          Nunca superan lo que el rol de la persona permite. «Editar» también habilita eliminar y publicar,
          si su rol puede.
        </p>
      </fieldset>

      <Input
        label="Caduca el (opcional)"
        type="date"
        value={expiresOn}
        onChange={(e) => setExpiresOn(e.target.value)}
      />

      <div className="mt-1 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" disabled={pending || (!grant && recipients.length === 0)}>
          {pending ? "Guardando…" : grant ? "Guardar" : "Conceder acceso"}
        </Button>
      </div>
    </form>
  );
}

export function GrantsManager({
  grants,
  recipients,
  resourceOptions,
}: {
  grants: GrantRow[];
  recipients: Option[];
  resourceOptions: ResourceOptions;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [revoking, setRevoking] = useState<GrantRow | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [notice, setNotice] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const visible = showAll ? grants : grants.filter((g) => g.state === "active");

  return (
    <section>
      <SectionHeader
        title="Accesos concedidos"
        action={
          <Button size="sm" onClick={() => setEditing({ mode: "create" })}>
            <PlusIcon size={16} />
            Conceder acceso
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar accesos">
        <Chip selected={!showAll} onClick={() => setShowAll(false)}>
          Vigentes
        </Chip>
        <Chip selected={showAll} onClick={() => setShowAll(true)}>
          Todos
        </Chip>
      </div>
      <div aria-live="polite" className="mb-4 empty:hidden">
        {notice ? (
          <Notice variant={notice.ok ? "success" : "error"}>{notice.message ?? "Hecho."}</Notice>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<KeyIcon size={22} />}
          title="No hay accesos concedidos"
          description="Concede acceso a una persona sobre un artista, sesión, carpeta, archivo, beat o el Vault."
        />
      ) : (
        <div className="rounded-card border border-line bg-surface">
          <table className="w-full table-fixed text-left">
            <caption className="sr-only">Accesos concedidos</caption>
            <thead className="hidden wide:table-header-group">
              <tr className="text-caption text-text-3">
                <th scope="col" className="px-4 py-3 font-medium">Recurso</th>
                <th scope="col" className="w-40 px-4 py-3 font-medium">Persona</th>
                <th scope="col" className="w-12 px-1 py-3 text-center font-medium">Ver</th>
                <th scope="col" className="w-20 px-1 py-3 text-center font-medium">Descargar</th>
                <th scope="col" className="w-12 px-1 py-3 text-center font-medium">Subir</th>
                <th scope="col" className="w-14 px-1 py-3 text-center font-medium">Editar</th>
                <th scope="col" className="hidden w-28 px-4 py-3 font-medium xl:table-cell">Caduca</th>
                <th scope="col" className="w-28 px-4 py-3 wide:w-44"><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((grant) => (
                <tr key={grant.id} className="border-t border-line align-middle">
                  <td className="px-4 py-3">
                    <p className="truncate text-body font-medium text-text">{grant.resourceLabel}</p>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-text-2">
                      {RESOURCE_LABEL[grant.resourceType]}
                      {grant.state !== "active" ? (
                        <Badge variant="outline">{GRANT_STATE_LABEL[grant.state]}</Badge>
                      ) : null}
                    </p>
                    <p className="mt-1 text-caption text-text-3 wide:hidden">
                      {grant.userName} · {flagsText(grant)}
                      {grant.expiresLabel ? ` · caduca el ${grant.expiresLabel}` : ""}
                    </p>
                  </td>
                  <td className="hidden px-4 py-3 wide:table-cell">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={grant.userName} size="sm" />
                      <span className="truncate text-body text-text">{grant.userName}</span>
                    </div>
                  </td>
                  {([grant.canView, grant.canDownload, grant.canUpload, grant.canEdit] as const).map((on, i) => (
                    <td key={i} className="hidden px-1 py-3 text-center text-text-2 wide:table-cell">
                      {on ? (
                        <>
                          <CheckIcon size={16} className="mx-auto text-text" />
                          <span className="sr-only">Sí</span>
                        </>
                      ) : (
                        <>
                          <span aria-hidden="true" className="text-text-3">–</span>
                          <span className="sr-only">No</span>
                        </>
                      )}
                    </td>
                  ))}
                  <td className="hidden px-4 py-3 text-label text-text-2 xl:table-cell">
                    {grant.expiresLabel ?? "No caduca"}
                  </td>
                  <td className="px-4 py-3">
                    {grant.state !== "revoked" ? (
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing({ mode: "edit", grant })}
                          aria-label={`Editar el acceso de ${grant.userName} a ${grant.resourceLabel}`}
                        >
                          Editar
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRevoking(grant)}
                          aria-label={`Revocar el acceso de ${grant.userName} a ${grant.resourceLabel}`}
                        >
                          Revocar
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.mode === "edit" ? "Editar acceso" : "Conceder acceso"}
        description={
          editing?.mode === "edit"
            ? undefined
            : "Elige a quién, sobre qué y con qué permisos. Quedará anotado en la auditoría."
        }
      >
        {editing ? (
          <GrantForm
            editing={editing}
            recipients={recipients}
            resourceOptions={resourceOptions}
            onClose={() => setEditing(null)}
            onDone={(result) => {
              setNotice(result);
              setEditing(null);
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revocar acceso"
        description={
          revoking
            ? `${revoking.userName} dejará de tener este acceso de inmediato. Podrás concederlo de nuevo cuando quieras.`
            : undefined
        }
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRevoking(null)}>
            Cancelar
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              const target = revoking;
              setRevoking(null);
              if (target) startTransition(async () => setNotice(await revokeGrant(target.id)));
            }}
          >
            Revocar
          </Button>
        </div>
      </Modal>
    </section>
  );
}
