"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { createVaultGrant, listVaultFolderChoices, listVaultGrants, revokeVaultGrant, type VaultGrantRow } from "@/app/actions/vault";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";

const day = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "Atlantic/Canary" });
const LOCKED = "No se pudo. Abre y desbloquea el Vault (/vault) para gestionar accesos: esta acción también exige tu desbloqueo.";

/**
 * «Dar acceso al Vault» (solo owner): a todo el Vault o a carpetas concretas, con caducidad OBLIGATORIA (máx. 90
 * días, 30 por defecto), permisos (ver, descargar, subir, editar) y revocación inmediata. Una persona sin la
 * verificación en dos pasos activada puede recibir el acceso pero no usarlo. El rol de la persona sigue siendo el techo.
 */
export function VaultAccessPanel({ recipients }: { recipients: { value: string; label: string }[] }) {
  const [grants, setGrants] = useState<VaultGrantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const reload = useCallback(() => {
    void listVaultGrants().then((res) => {
      if (res.ok && res.data) {
        setGrants(res.data);
        setError(null);
      } else {
        setGrants([]);
        setError(LOCKED);
      }
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <section aria-labelledby="vault-access">
      <SectionHeader title="Acceso al Vault" action={<Button size="sm" onClick={() => setOpen(true)}>Dar acceso al Vault</Button>} />
      <h3 id="vault-access" className="sr-only">
        Acceso al Vault
      </h3>
      {error ? (
        <Notice variant="info" className="mb-4">
          {error}
        </Notice>
      ) : null}
      {grants && grants.length > 0 ? (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface">
          {grants.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-body font-medium text-text">{g.name}</p>
                <p className="truncate text-label text-text-2">
                  {g.scope === "vault" ? "Todo el Vault" : `Carpeta: ${g.folderName ?? "—"}`} · {[g.canView && "ver", g.canDownload && "descargar", g.canUpload && "subir", g.canEdit && "editar"].filter(Boolean).join(", ")} · caduca el {day.format(new Date(g.expiresAt))}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">Vigente</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await revokeVaultGrant(g.id);
                      setError(res.ok ? null : res.message);
                      reload();
                    })
                  }
                >
                  Revocar
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : grants ? (
        <p className="text-label text-text-2">Nadie tiene acceso al Vault salvo tú.</p>
      ) : null}
      <Modal open={open} onClose={() => setOpen(false)} title="Dar acceso al Vault" description="El acceso caduca siempre. Puedes revocarlo cuando quieras.">
        <GrantForm
          recipients={recipients}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            reload();
          }}
        />
      </Modal>
    </section>
  );
}

function GrantForm({ recipients, onClose, onDone }: { recipients: { value: string; label: string }[]; onClose: () => void; onDone: () => void }) {
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [userId, setUserId] = useState(recipients[0]?.value ?? "");
  const [scope, setScope] = useState<"vault" | "folders">("vault");
  const [picked, setPicked] = useState<string[]>([]);
  const [flags, setFlags] = useState({ canView: true, canDownload: false, canUpload: false, canEdit: false });
  const [days, setDays] = useState("30");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void listVaultFolderChoices().then((res) => {
      if (!cancelled && res.ok && res.data) setFolders(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = () =>
    startTransition(async () => {
      const res = await createVaultGrant({ userId, folderIds: scope === "folders" ? picked : null, flags, days: Number(days) });
      if (res.ok) onDone();
      else setError(res.message === "No tienes permiso para hacer esto." ? LOCKED : res.message);
    });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Select label="Persona" value={userId} onChange={(e) => setUserId(e.target.value)} options={recipients.length > 0 ? recipients : [{ value: "", label: "No hay personas disponibles" }]} />
      <Select label="Alcance" value={scope} onChange={(e) => setScope(e.target.value as "vault" | "folders")} options={[{ value: "vault", label: "Todo el Vault" }, { value: "folders", label: "Carpetas concretas" }]} />
      {scope === "folders" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-label font-medium text-text-2">Carpetas</legend>
          {folders.map((f) => (
            <label key={f.id} className="flex items-center gap-2 text-body text-text">
              <input type="checkbox" checked={picked.includes(f.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, f.id] : picked.filter((x) => x !== f.id))} className="size-4 accent-[var(--text)]" />
              {f.name}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="flex flex-col gap-3">
        {(
          [
            ["canView", "Ver"],
            ["canDownload", "Descargar"],
            ["canUpload", "Subir"],
            ["canEdit", "Editar (mover, papelera)"],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <span className="text-body text-text">{label}</span>
            <Toggle label={label} checked={flags[key]} onChange={(v) => setFlags((f) => ({ ...f, [key]: v }))} />
          </div>
        ))}
      </div>
      <Input label="Caduca en (días, 1–90)" type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} className="w-32" />
      <p className="text-caption text-text-3">Sin la verificación en dos pasos activada, la persona recibe el acceso pero no podrá usarlo.</p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" size="sm" disabled={pending || !userId || (scope === "folders" && picked.length === 0)}>
          Conceder acceso
        </Button>
      </div>
    </form>
  );
}
