"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { saveBeatSettings } from "@/app/actions/beats";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Toggle } from "@/components/ui/Toggle";
import { useUploader } from "@/components/upload/useUploader";
import { formatBytes } from "@/lib/format";

const AUDIO = /\.(wav|mp3|flac|aiff?|m4a)$/i;

/**
 * Tag de voz de los previews (solo el propietario): el audio que se mezcla cada N segundos en el preview, si el beat
 * lo tiene activado. El original nunca lo lleva. Cambiar el tag o el intervalo solo afecta a los previews que se
 * generen o reprocesen a partir de ahora.
 */
export function BeatSettingsForm({
  initial,
  maxBytes,
}: {
  initial: { intervalS: number; defaultTagged: boolean; tagAssetId: string | null; tagName: string | null };
  maxBytes: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [interval, setInterval] = useState(String(initial.intervalS));
  const [defaultTagged, setDefaultTagged] = useState(initial.defaultTagged);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const uploader = useUploader({ maxBytes, purpose: "voice-tag", defaultType: "beat" });
  const input = useRef<HTMLInputElement>(null);
  const linked = useRef(new Set<string>());

  const save = (tagAssetId?: string | null) =>
    startTransition(async () => {
      const res = await saveBeatSettings({ intervalS: Number(interval), defaultTagged, ...(tagAssetId !== undefined ? { voiceTagAssetId: tagAssetId } : {}) });
      setMessage({ kind: res.ok ? "success" : "error", text: res.message || (res.ok ? "Guardado." : "No se pudo guardar.") });
      if (res.ok) router.refresh();
    });

  // Al terminar de subir el tag, se activa como el tag vigente
  useEffect(() => {
    for (const item of uploader.items) {
      if (item.status !== "done" || !item.assetId || linked.current.has(item.assetId)) continue;
      linked.current.add(item.assetId);
      const assetId = item.assetId;
      void saveBeatSettings({ intervalS: Number(interval) || initial.intervalS, defaultTagged, voiceTagAssetId: assetId }).then((res) => {
        setMessage({ kind: res.ok ? "success" : "error", text: res.ok ? "Tag de voz actualizado." : res.message });
        if (res.ok) router.refresh();
      });
    }
  }, [uploader.items, interval, defaultTagged, initial.intervalS, router]);

  const busy = uploader.items.find((i) => i.status !== "done" && i.status !== "canceled" && i.status !== "error");
  const failed = uploader.items.find((i) => i.status === "error");

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      {message ? <Notice variant={message.kind}>{message.text}</Notice> : null}

      <section>
        <SectionHeader title="Tag de voz" />
        <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
          <p className="text-body text-text">{initial.tagName ? initial.tagName : "Todavía no hay un tag de voz."}</p>
          <p className="text-label text-text-2">Un audio corto (≥ 1,5 s). Se mezcla en el preview cada N segundos si el beat lo tiene activado.</p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={input}
              type="file"
              accept=".wav,.mp3,.flac,.aif,.aiff,.m4a,audio/*"
              className="sr-only"
              tabIndex={-1}
              aria-label="Elegir archivo de audio del tag"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                if (!AUDIO.test(file.name)) return setMessage({ kind: "error", text: "El tag debe ser un archivo de audio." });
                uploader.stage([file]);
                uploader.start();
              }}
            />
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => input.current?.click()}>
              {busy ? `Subiendo… ${Math.round(busy.progress * 100)} %` : initial.tagAssetId ? "Cambiar tag" : "Subir tag"}
            </Button>
            {initial.tagAssetId ? (
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => save(null)}>
                Quitar tag
              </Button>
            ) : null}
            <span className="text-caption text-text-3">Hasta {formatBytes(maxBytes)}</span>
          </div>
          {failed ? <p className="text-label text-text">{failed.error}</p> : null}
        </div>
      </section>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex flex-col gap-5"
      >
        <Input label="Cada cuántos segundos suena el tag" type="number" min={5} max={600} value={interval} onChange={(e) => setInterval(e.target.value)} hint="Entre 5 y 600 segundos." className="w-40" />
        <div className="flex items-start justify-between gap-4 rounded-card border border-line bg-surface p-4">
          <div>
            <p className="text-body font-medium text-text">Activar el tag en los beats nuevos</p>
            <p className="mt-1 text-label text-text-2">Cada beat se puede cambiar después; hacerlo regenera su preview.</p>
          </div>
          <Toggle label="Activar el tag en los beats nuevos" checked={defaultTagged} onChange={setDefaultTagged} />
        </div>
        <div>
          <Button type="submit" disabled={pending}>
            Guardar ajustes
          </Button>
        </div>
      </form>
    </div>
  );
}
