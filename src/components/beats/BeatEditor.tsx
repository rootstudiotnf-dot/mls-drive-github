"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  createGenre,
  getBeatDownloadUrl,
  reprocessBeat,
  setBeatCover,
  setBeatTags,
  suggestTags,
  updateBeat,
  type BeatActivityEntry,
} from "@/app/actions/beats";
import { getThumbUrls } from "@/app/actions/browse";
import { listComments } from "@/app/actions/comments";
import { CommentsPanel } from "@/components/comments/CommentsPanel";
import { DownloadIcon, MusicIcon, PauseIcon, PlayIcon } from "@/components/icons";
import { usePlayer } from "@/components/player/PlayerProvider";
import { WaveformCanvas } from "@/components/player/WaveformCanvas";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Notice } from "@/components/ui/Notice";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import { useUploader } from "@/components/upload/useUploader";
import { actionText } from "@/lib/activity-labels";
import type { BeatDetail } from "@/lib/beats/data";
import { formatDuration, MUSICAL_KEYS, publishProblems } from "@/lib/beats/types";
import type { CommentsData } from "@/lib/comments/types";
import { BeatSharePanel } from "./BeatSharePanel";
import { CoverCropModal } from "./CoverCropModal";

export type BeatCaps = {
  edit: boolean;
  publish: boolean;
  /** ¿Puede esta persona descargar el original (las tres capas)? */
  download: boolean;
  /** ¿Su rol permite conceder descargas a artistas? */
  grantDownload: boolean;
};

const when = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Atlantic/Canary" });

/**
 * Ficha del beat: portada, forma de onda interactiva (usa el reproductor global), datos editables, compartir,
 * comentarios con marca de tiempo (el panel de la Fase 6) y actividad. Todo lo que aquí se ofrece lo vuelve a
 * comprobar el servidor; las `caps` solo deciden qué se muestra.
 */
export function BeatEditor({
  beat,
  genres: initialGenres,
  artists,
  caps,
  maxBytes,
  activity,
}: {
  beat: BeatDetail;
  genres: { id: string; name: string }[];
  artists: { id: string; name: string }[];
  caps: BeatCaps;
  maxBytes: number;
  activity: BeatActivityEntry[] | null;
}) {
  const router = useRouter();
  const player = usePlayer();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  // Formulario
  const [title, setTitle] = useState(beat.title);
  const [bpm, setBpm] = useState(beat.bpm === null ? "" : String(beat.bpm));
  const [key, setKey] = useState(beat.key ?? "");
  const [genreId, setGenreId] = useState(beat.genreId ?? "");
  const [createdOn, setCreatedOn] = useState(beat.createdOn);
  const [downloadable, setDownloadable] = useState(beat.downloadable);
  const [tagged, setTagged] = useState(beat.previewTagged);
  const [tags, setTags] = useState<string[]>(beat.tags);
  const [tagInput, setTagInput] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [genres, setGenres] = useState(initialGenres);
  const [newGenre, setNewGenre] = useState("");

  const bpmNumber = bpm.trim() === "" ? null : Number(bpm);
  const missing = publishProblems({ title, bpm: bpmNumber, key: key || null, genreId: genreId || null, previewReady: beat.previewReady });

  const fields = () => ({
    title,
    bpm: bpmNumber,
    key: key || null,
    genreId: genreId || null,
    createdOn,
    downloadable,
    previewTagged: tagged,
  });

  /** Guarda los datos (y, si se pide, cambia el estado en el mismo paso). */
  const commit = (status?: "draft" | "published") =>
    startTransition(async () => {
      const res = await updateBeat(beat.id, status ? { ...fields(), status } : fields());
      if (!res.ok) return setMessage({ kind: "error", text: res.message });
      const tagRes = await setBeatTags(beat.id, tags);
      if (!tagRes.ok) return setMessage({ kind: "error", text: tagRes.message });
      setMessage({ kind: "success", text: status === "published" ? "Beat publicado." : status === "draft" ? "Beat devuelto a borrador." : "Cambios guardados." });
      router.refresh();
    });

  // Etiquetas: autocompletado por prefijo
  useEffect(() => {
    if (!tagInput.trim()) return;
    const timer = setTimeout(() => {
      void suggestTags(tagInput).then((res) => {
        if (res.ok && res.data) setSuggestions(res.data.filter((s) => !tags.includes(s)));
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [tagInput, tags]);

  const addTag = (raw: string) => {
    const name = raw.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 30);
    if (name && !tags.includes(name) && tags.length < 15) setTags([...tags, name]);
    setTagInput("");
    setSuggestions([]);
  };

  // Mientras el preview se procesa, se consulta el estado cada 5 s
  const processing = beat.jobStatus === "queued" || beat.jobStatus === "processing";
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [processing, router]);

  // Portada
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const coverId = beat.coverAssetId;
  useEffect(() => {
    if (!coverId) return;
    let cancelled = false;
    void getThumbUrls([coverId], "web").then((res) => {
      if (!cancelled) setCoverUrl(res.ok && res.data ? (res.data[coverId] ?? null) : null);
    });
    return () => {
      cancelled = true;
    };
  }, [coverId]);

  const coverUploader = useUploader({ maxBytes, purpose: "beat-cover", defaultType: "photo" });
  const [cropping, setCropping] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const linked = useRef(new Set<string>());
  useEffect(() => {
    for (const item of coverUploader.items) {
      if (item.status !== "done" || !item.assetId || linked.current.has(item.assetId)) continue;
      const assetId = item.assetId;
      linked.current.add(assetId);
      void setBeatCover(beat.id, assetId).then((res) => {
        setMessage(res.ok ? { kind: "success", text: "Portada actualizada." } : { kind: "error", text: res.message });
        if (res.ok) router.refresh();
      });
    }
  }, [coverUploader.items, beat.id, router]);
  const coverBusy = coverUploader.items.find((i) => i.status !== "done" && i.status !== "canceled");

  // Reproducción: la forma de onda controla el reproductor global
  const isCurrent = player.track?.id === beat.id;
  const track = useMemo(() => [{ id: beat.id, title: beat.title }], [beat.id, beat.title]);
  const progress = isCurrent && player.duration > 0 ? player.current / player.duration : 0;
  const duration = isCurrent && player.duration > 0 ? player.duration : (beat.durationSeconds ?? 0);
  const playAt = useCallback((seconds: number) => (isCurrent ? player.seek(seconds) : player.playQueue(track, 0, seconds)), [isCurrent, player, track]);
  const togglePlay = () => (isCurrent ? player.toggle() : player.playQueue(track, 0));

  // Comentarios (el mismo panel que en vídeo; el asset es el audio del beat)
  const [comments, setComments] = useState<CommentsData>({ comments: [], canComment: false, canModerate: false });
  const refreshComments = useCallback(async () => {
    const res = await listComments(beat.assetId);
    if (res.ok && res.data) setComments(res.data);
  }, [beat.assetId]);
  useEffect(() => {
    let cancelled = false;
    void listComments(beat.assetId).then((res) => {
      if (!cancelled && res.ok && res.data) setComments(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [beat.assetId]);

  const download = async () => {
    const res = await getBeatDownloadUrl(beat.id);
    if (!res.ok || !res.data) return setMessage({ kind: "error", text: res.ok ? "No se pudo descargar." : res.message });
    const a = document.createElement("a");
    a.href = res.data.url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="grid min-w-0 gap-10 min-[1100px]:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-10">
        {/* Cabecera: portada + título + reproducción */}
        <div className="flex flex-col gap-6 sm:flex-row">
          <div className="flex w-full max-w-60 shrink-0 flex-col gap-2">
            <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-card border border-line bg-tone-2">
              {coverUrl && coverId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={coverUrl} alt={`Portada de ${beat.title}`} className="absolute inset-0 size-full object-cover" />
              ) : (
                <MusicIcon size={40} className="text-text-3" />
              )}
            </div>
            {caps.edit ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  aria-label="Elegir imagen de portada"
                  tabIndex={-1}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) setCropping(file);
                  }}
                />
                <Button size="sm" variant="ghost" disabled={!!coverBusy} onClick={() => fileInput.current?.click()}>
                  {coverBusy ? `Subiendo portada… ${Math.round(coverBusy.progress * 100)} %` : coverId ? "Cambiar portada" : "Añadir portada"}
                </Button>
              </>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-1 flex-col justify-between gap-5">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant={beat.status === "published" ? "neutral" : "outline"}>{beat.status === "published" ? "Publicado" : "Borrador"}</Badge>
                {beat.downloadable ? <Badge variant="outline">Descarga permitida</Badge> : null}
              </div>
              <h1 className="text-title break-words text-text">{beat.title}</h1>
              <p className="mt-2 text-body text-text-2">
                {[beat.genre, beat.bpm ? `${beat.bpm} BPM` : null, beat.key, formatDuration(beat.durationSeconds)].filter(Boolean).join(" · ") || "Sin datos todavía"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={togglePlay}
                disabled={!beat.previewReady}
                aria-label={isCurrent && player.playing ? "Pausar" : "Reproducir"}
                className="flex size-12 items-center justify-center rounded-pill bg-text text-bg transition-colors duration-150 ease-ui hover:bg-text-2 disabled:opacity-30"
              >
                {isCurrent && player.playing ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
              </button>
              {caps.download ? (
                <Button variant="ghost" onClick={() => void download()}>
                  <DownloadIcon size={16} />
                  Descargar original
                </Button>
              ) : null}
              {caps.publish ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending || processing}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await reprocessBeat(beat.id);
                      setMessage(res.ok ? { kind: "success", text: "Reprocesando el preview…" } : { kind: "error", text: res.message });
                      if (res.ok) router.refresh();
                    })
                  }
                >
                  Reprocesar preview
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        {/* Forma de onda */}
        <section aria-label="Forma de onda">
          {processing ? (
            <Notice variant="info">Procesando el preview… puede tardar unos segundos. Esta página se actualiza sola.</Notice>
          ) : beat.jobStatus === "failed" ? (
            <Notice variant="error">
              No se pudo procesar el preview{beat.jobError ? `: ${beat.jobError}` : "."} {caps.publish ? "Prueba con «Reprocesar preview»." : ""}
            </Notice>
          ) : null}
          <div className="mt-3 rounded-card border border-line bg-surface px-4 py-4">
            <WaveformCanvas
              peaks={beat.waveform}
              progress={progress}
              height={96}
              label="Posición del beat"
              onSeek={beat.previewReady && duration > 0 ? (fraction) => playAt(fraction * duration) : undefined}
            />
            <p className="mt-2 text-caption text-text-3">
              {formatDuration(isCurrent ? player.current : 0)} / {formatDuration(duration || null)}
            </p>
          </div>
        </section>

        {message ? <Notice variant={message.kind === "success" ? "success" : "error"}>{message.text}</Notice> : null}

        {/* Datos */}
        {caps.edit ? (
          <section aria-labelledby="data-title">
            <SectionHeader title="Datos del beat" />
            <h3 id="data-title" className="sr-only">
              Datos del beat
            </h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                commit();
              }}
              className="flex flex-col gap-5"
            >
              <Input label="Título" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required />
              <div className="grid gap-5 sm:grid-cols-3">
                <Input label="BPM" type="number" inputMode="numeric" min={20} max={400} value={bpm} onChange={(e) => setBpm(e.target.value)} />
                <Select label="Tonalidad" value={key} onChange={(e) => setKey(e.target.value)} options={[{ value: "", label: "Sin definir" }, ...MUSICAL_KEYS.map((k) => ({ value: k, label: k }))]} />
                <Input label="Fecha" type="date" value={createdOn} onChange={(e) => setCreatedOn(e.target.value)} />
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <div className="w-64 max-w-full">
                  <Select label="Género" value={genreId} onChange={(e) => setGenreId(e.target.value)} options={[{ value: "", label: "Sin género" }, ...genres.map((g) => ({ value: g.id, label: g.name }))]} />
                </div>
                <div className="flex items-end gap-2">
                  <Input label="Nuevo género" value={newGenre} maxLength={40} onChange={(e) => setNewGenre(e.target.value)} className="w-44" />
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending || !newGenre.trim()}
                    onClick={() =>
                      startTransition(async () => {
                        const res = await createGenre(newGenre);
                        if (!res.ok || !res.data) return setMessage({ kind: "error", text: res.ok ? "No se pudo crear." : res.message });
                        const created = res.data;
                        setGenres((list) => (list.some((g) => g.id === created.id) ? list : [...list, created].sort((a, b) => a.name.localeCompare(b.name, "es"))));
                        setGenreId(created.id);
                        setNewGenre("");
                      })
                    }
                  >
                    Crear
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Input
                  label="Etiquetas"
                  hint="Escribe y pulsa Intro. Se sugieren las que ya existen."
                  value={tagInput}
                  maxLength={30}
                  onChange={(e) => {
                    setTagInput(e.target.value);
                    if (!e.target.value.trim()) setSuggestions([]);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addTag(tagInput);
                    }
                  }}
                />
                {tagInput.trim() && suggestions.length > 0 ? (
                  <ul className="flex flex-wrap gap-1.5" aria-label="Sugerencias de etiquetas">
                    {suggestions.map((s) => (
                      <li key={s}>
                        <button type="button" onClick={() => addTag(s)} className="h-8 rounded-pill border border-line px-3 text-label text-text-2 transition-colors duration-150 ease-ui hover:border-line-hover hover:text-text">
                          {s}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {tags.length > 0 ? (
                  <ul className="flex flex-wrap gap-1.5" aria-label="Etiquetas del beat">
                    {tags.map((t) => (
                      <li key={t}>
                        <button
                          type="button"
                          aria-label={`Quitar la etiqueta ${t}`}
                          onClick={() => setTags(tags.filter((x) => x !== t))}
                          className="h-8 rounded-pill bg-active px-3 text-label text-text transition-colors duration-150 ease-ui hover:bg-hover"
                        >
                          {t} ×
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <div className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-body font-medium text-text">Permitir descargar el original</p>
                    <p className="mt-1 max-w-lg text-label text-text-2">
                      Una de las tres condiciones para que un artista descargue: además hace falta «Puede descargar» en su acceso y el permiso de su rol. Sin esto solo escucha.
                    </p>
                  </div>
                  <Toggle label="Permitir descargar el original" checked={downloadable} onChange={setDownloadable} />
                </div>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-body font-medium text-text">Tag de voz en el preview</p>
                    <p className="mt-1 max-w-lg text-label text-text-2">Mezcla el tag de voz del propietario en el preview. Cambiarlo regenera el preview; el original no se toca.</p>
                  </div>
                  <Toggle label="Tag de voz en el preview" checked={tagged} onChange={setTagged} />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={pending}>
                  Guardar cambios
                </Button>
                {caps.publish ? (
                  beat.status === "published" ? (
                    <Button type="button" variant="ghost" disabled={pending} onClick={() => commit("draft")}>
                      Volver a borrador
                    </Button>
                  ) : (
                    <Button type="button" variant="ghost" disabled={pending || missing.length > 0} onClick={() => commit("published")}>
                      Publicar
                    </Button>
                  )
                ) : null}
              </div>
              {caps.publish && beat.status === "draft" && missing.length > 0 ? (
                <p className="text-label text-text-2" role="status">
                  Para publicar falta: {missing.join(", ")}.
                </p>
              ) : null}
            </form>
          </section>
        ) : (
          <section>
            <SectionHeader title="Datos del beat" />
            <dl className="grid gap-4 text-body sm:grid-cols-2">
              <div>
                <dt className="text-label text-text-3">Género</dt>
                <dd className="text-text">{beat.genre ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-label text-text-3">BPM y tonalidad</dt>
                <dd className="text-text">{[beat.bpm, beat.key].filter(Boolean).join(" · ") || "—"}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-label text-text-3">Etiquetas</dt>
                <dd className="text-text">{beat.tags.length > 0 ? beat.tags.join(", ") : "—"}</dd>
              </div>
            </dl>
          </section>
        )}

        <BeatSharePanel beatId={beat.id} status={beat.status} shared={beat.sharedWith} artists={artists} canEdit={caps.edit} canGrantDownload={caps.grantDownload} onChanged={() => router.refresh()} />

        {activity && activity.length > 0 ? (
          <section>
            <SectionHeader title="Actividad" />
            <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
              {activity.map((a) => (
                <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 text-label">
                  <span className="min-w-0 text-text-2">
                    <span className="font-medium text-text">{a.actorName}</span> {actionText(a.action)}
                  </span>
                  <time dateTime={a.createdAt} className="text-caption text-text-3">
                    {when.format(new Date(a.createdAt))}
                  </time>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <CommentsPanel
        assetId={beat.assetId}
        data={comments}
        activeId={null}
        getTimeMs={() => (isCurrent ? Math.round(player.current * 1000) : 0)}
        pause={() => player.pause()}
        seekMs={(ms) => playAt(ms / 1000)}
        onChanged={() => void refreshComments()}
      />

      <CoverCropModal
        file={cropping}
        onCancel={() => setCropping(null)}
        onDone={(file) => {
          setCropping(null);
          coverUploader.stage([file]);
          coverUploader.start();
        }}
      />
    </div>
  );
}
