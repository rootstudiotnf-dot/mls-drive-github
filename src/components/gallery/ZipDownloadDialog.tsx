"use client";

import { useCallback, useRef, useState } from "react";
import { getDownloadUrls, prepareSessionDownload, logSessionZip, type DownloadPlan } from "@/app/actions/sessions";
import { getAssetUrl } from "@/app/actions/uploads";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Progress } from "@/components/ui/Progress";
import { Select } from "@/components/ui/Select";
import { variantAllowed, type DownloadMode } from "@/lib/assets/variants";
import { formatBytes } from "@/lib/format";
import {
  openFileSink,
  openMemorySink,
  planParts,
  supportsDirectWrite,
  writeZipPart,
  ZipCancelled,
  ZipFileError,
  type ZipPart,
} from "./zipDownload";

type Phase = "choose" | "preparing" | "ready" | "running" | "error";

/** Descarga de una selección o de toda la sesión como ZIP (en el navegador), con progreso y cancelación. */
export function ZipDownloadDialog({
  open,
  onClose,
  sessionId,
  sessionName,
  downloadMode,
  ids,
  count,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  sessionName: string;
  downloadMode: DownloadMode;
  /** null = toda la sesión */
  ids: string[] | null;
  count: number;
}) {
  const [variant, setVariant] = useState<"original" | "web">(variantAllowed(downloadMode, "original") ? "original" : "web");
  const [phase, setPhase] = useState<Phase>("choose");
  const [message, setMessage] = useState<string | null>(null);
  const [plan, setPlan] = useState<DownloadPlan | null>(null);
  const [parts, setParts] = useState<ZipPart[]>([]);
  const [doneParts, setDoneParts] = useState<Set<number>>(new Set());
  const [active, setActive] = useState<number | null>(null);
  const [bytes, setBytes] = useState(0);
  const [files, setFiles] = useState(0);
  const [failedFile, setFailedFile] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const totals = useRef({ files: 0, bytes: 0 });
  const direct = supportsDirectWrite();

  const prepare = async () => {
    setPhase("preparing");
    setMessage(null);
    const res = await prepareSessionDownload({ sessionId, ids, variant });
    if (!res.ok || !res.data) {
      setMessage(res.ok ? "No se pudo preparar la descarga." : res.message);
      setPhase("error");
      return;
    }
    setPlan(res.data);
    setParts(planParts(res.data.files, sessionName, direct));
    setPhase("ready");
  };

  // URLs de descarga pedidas de 8 en 8 (valen 2 minutos): una llamada cubre varias fotos y, si una caduca o
  // falla, se pide otra nueva solo para esa. Cada foto se autoriza y se registra por separado en el servidor.
  const feeder = useRef<{ urls: Map<string, { url: string; at: number }>; pending: Map<string, Promise<void>> }>({ urls: new Map(), pending: new Map() });
  const getUrl = useCallback(
    async (id: string) => {
      const ids = plan?.files.map((f) => f.id) ?? [id];
      const { urls, pending } = feeder.current;
      const freshOf = (key: string) => {
        const hit = urls.get(key);
        return hit && Date.now() - hit.at < 90_000 ? hit : null;
      };
      const fresh = () => freshOf(id);
      if (!fresh()) {
        let load = pending.get(id);
        if (!load) {
          const start = Math.max(0, ids.indexOf(id));
          const group = ids.slice(start, start + 8).filter((x) => x === id || (!freshOf(x) && !pending.has(x)));
          load = getDownloadUrls(group, variant).then((res) => {
            const now = Date.now();
            if (res.ok && res.data) for (const [key, url] of Object.entries(res.data)) urls.set(key, { url, at: now });
            for (const key of group) pending.delete(key);
          });
          for (const key of group) pending.set(key, load);
        }
        await load;
      }
      const hit = fresh();
      if (!hit) {
        // Fallback: una URL individual
        const res = await getAssetUrl(id, variant, "download");
        if (!res.ok || !res.data) throw new Error(res.ok ? "sin url" : res.message);
        return res.data.url;
      }
      urls.delete(id); // cada URL se usa una sola vez
      return hit.url;
    },
    [variant, plan],
  );

  const runPart = async (part: ZipPart) => {
    // Con acceso a disco, el selector de archivo exige estar dentro del gesto del usuario: se abre ANTES de await
    let sink;
    try {
      sink = direct ? await openFileSink(part.fileName) : openMemorySink(part.fileName);
    } catch {
      return; // el usuario cerró el selector: no es un error
    }
    const abort = new AbortController();
    controller.current = abort;
    setActive(part.index);
    setPhase("running");
    setFailedFile(null);
    let partBytes = 0;
    try {
      const result = await writeZipPart({
        part,
        sink,
        getUrl,
        signal: abort.signal,
        onBytes: (delta) => {
          partBytes += delta;
          setBytes((b) => b + delta);
        },
        onFile: () => setFiles((f) => f + 1),
      });
      totals.current = { files: totals.current.files + part.files.length, bytes: totals.current.bytes + result.bytes };
      const finished = new Set(doneParts).add(part.index);
      setDoneParts(finished);
      setActive(null);
      setPhase("ready");
      if (finished.size === parts.length) {
        setMessage("Descarga completa.");
        void logSessionZip({ sessionId, files: totals.current.files, bytes: totals.current.bytes, variant, parts: parts.length, completed: true });
      }
    } catch (error) {
      setActive(null);
      if (error instanceof ZipCancelled) {
        setMessage("Descarga cancelada.");
        setPhase("ready");
        void logSessionZip({ sessionId, files: totals.current.files, bytes: totals.current.bytes + partBytes, variant, parts: parts.length, completed: false });
      } else {
        setFailedFile(error instanceof ZipFileError ? error.fileName : null);
        setMessage("No se pudo completar el ZIP. Puedes descargar las fotos una a una.");
        setPhase("error");
      }
    } finally {
      controller.current = null;
    }
  };

  const downloadOne = async (id: string) => {
    try {
      const url = await getUrl(id);
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setMessage("No se pudo descargar esa foto.");
    }
  };

  const total = plan?.files.reduce((n, f) => n + f.size, 0) ?? 0;
  const progress = total > 0 ? Math.min(1, bytes / total) : 0;
  const busy = phase === "running";

  return (
    <Modal
      open={open}
      onClose={() => {
        controller.current?.abort();
        onClose();
      }}
      title={ids === null ? "Descargar toda la sesión" : "Descargar selección"}
      description={`${count} ${count === 1 ? "foto" : "fotos"} en un ZIP. Se crea en tu navegador: nada pasa por nuestros servidores.`}
    >
      <div className="flex flex-col gap-4" aria-live="polite">
        {message ? <Notice variant={phase === "error" ? "error" : "info"}>{message}</Notice> : null}

        {phase === "choose" || phase === "preparing" ? (
          <>
            {variantAllowed(downloadMode, "original") ? (
              <Select
                label="Versión"
                value={variant}
                onChange={(e) => setVariant(e.target.value as "original" | "web")}
                options={[
                  { value: "original", label: "Original (máxima calidad)" },
                  { value: "web", label: "Versión web (2048 px, más ligera)" },
                ]}
              />
            ) : (
              <p className="text-label text-text-2">Se descarga la versión web (2048 px).</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button onClick={() => void prepare()} disabled={phase === "preparing"}>
                {phase === "preparing" ? "Preparando…" : "Continuar"}
              </Button>
            </div>
          </>
        ) : null}

        {(phase === "ready" || phase === "running" || phase === "error") && plan ? (
          <>
            <p className="text-label text-text-2">
              {plan.files.length} {plan.files.length === 1 ? "foto" : "fotos"} · {variant === "web" ? "aprox. " : ""}
              {formatBytes(total)} · {parts.length} {parts.length === 1 ? "archivo ZIP" : "archivos ZIP"}
              {parts.length > 1 ? " (se divide por tamaño y por número de fotos)" : ""}
            </p>
            {!direct ? (
              <p className="text-caption text-text-3">
                Este navegador arma el ZIP en memoria, así que se reparte en partes de hasta 1 GB.
              </p>
            ) : null}

            {busy ? (
              <div className="flex flex-col gap-2">
                <Progress value={progress} label="Progreso de la descarga" />
                <p className="text-caption text-text-3">
                  Parte {active} de {parts.length} · {files} {files === 1 ? "foto" : "fotos"} · {formatBytes(bytes)}
                </p>
                <Button variant="ghost" className="self-start" onClick={() => controller.current?.abort()}>
                  Cancelar descarga
                </Button>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {parts.map((part) => {
                  const finished = doneParts.has(part.index);
                  return (
                    <li key={part.index} className="flex items-center justify-between gap-3 rounded-control border border-line px-3 py-2">
                      <span className="min-w-0">
                        <span className="block truncate text-label text-text">{part.fileName}</span>
                        <span className="block text-caption text-text-3">
                          {part.files.length} {part.files.length === 1 ? "foto" : "fotos"} · {formatBytes(part.bytes)}
                        </span>
                      </span>
                      <Button size="sm" variant={finished ? "ghost" : "primary"} onClick={() => void runPart(part)}>
                        {finished ? "Volver a descargar" : parts.length > 1 ? `Descargar parte ${part.index}` : "Descargar ZIP"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}

            {phase === "error" ? (
              <div className="flex flex-col gap-2">
                {failedFile ? <p className="text-caption text-text-3">Falló: {failedFile}</p> : null}
                <p className="text-label font-medium text-text">Descargar una a una</p>
                <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                  {plan.files.slice(0, 100).map((file) => (
                    <li key={file.id} className="flex items-center justify-between gap-3 text-label text-text-2">
                      <span className="truncate">{file.name}</span>
                      <Button size="sm" variant="ghost" onClick={() => void downloadOne(file.id)} aria-label={`Descargar ${file.name}`}>
                        Descargar
                      </Button>
                    </li>
                  ))}
                </ul>
                {plan.files.length > 100 ? <p className="text-caption text-text-3">Se muestran las 100 primeras.</p> : null}
              </div>
            ) : null}

            {!busy ? (
              <div className="flex justify-end">
                <Button variant="ghost" onClick={onClose}>
                  Cerrar
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
