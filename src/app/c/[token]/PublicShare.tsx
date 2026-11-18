"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MusicIcon, PlayIcon } from "@/components/icons";
import { openFileSink, openMemorySink, planParts, supportsDirectWrite, writeZipPart, ZipCancelled, type ZipPart } from "@/components/gallery/zipDownload";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Progress } from "@/components/ui/Progress";
import { formatBytes } from "@/lib/format";
import { formatTimecode } from "@/lib/comments/types";
import type { PublicItem } from "@/lib/share/server";
import { shareAddComment, shareComments, shareList, shareSign, type PublicComment, type ShareListData } from "./actions";

const dayFormat = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "Atlantic/Canary" });

type Props = {
  token: string;
  title: string;
  message: string | null;
  type: "session" | "folder" | "asset_set" | "beat_set";
  canDownload: boolean;
  canComment: boolean;
  expiresAt: string;
  initial: ShareListData;
};

/** Página pública de un enlace: cabecera mínima, rejilla o lista de beats, visor, comentarios y descarga si procede. */
export function PublicShare({ token, title, message, type, canDownload, canComment, expiresAt, initial }: Props) {
  const [items, setItems] = useState<PublicItem[]>(initial.items);
  const [thumbs, setThumbs] = useState<Record<string, string>>(initial.thumbs);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isBeats = type === "beat_set";

  const more = async () => {
    setLoading(true);
    const res = await shareList({ token, cursor });
    setLoading(false);
    if (!res.ok || !res.data) return setNotice("No se pudo cargar más.");
    const data = res.data;
    setItems((c) => [...c, ...data.items]);
    setThumbs((t) => ({ ...t, ...data.thumbs }));
    setCursor(data.nextCursor);
  };

  const download = async (id: string) => {
    const res = await shareSign({ token, assetId: id, mode: "download" });
    if (!res.ok || !res.data) return setNotice(res.ok ? "No se pudo descargar." : res.message);
    const a = document.createElement("a");
    a.href = res.data.url;
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-8 px-5 py-10 sm:px-8">
      <header className="flex flex-col gap-2">
        <p className="text-label text-text-3">Material compartido contigo</p>
        <h1 className="text-title text-text">{title}</h1>
        {message ? <p className="max-w-2xl whitespace-pre-line text-body text-text-2">{message}</p> : null}
        <p className="text-caption text-text-3">Disponible hasta el {dayFormat.format(new Date(expiresAt))}.</p>
      </header>

      {notice ? <Notice variant="error">{notice}</Notice> : null}
      {canDownload && !isBeats ? <ZipSection token={token} title={title} /> : null}

      {items.length === 0 ? (
        <p className="text-body text-text-2">No hay nada que mostrar en este enlace.</p>
      ) : isBeats ? (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface">
          {items.map((item, index) => (
            <li key={item.id}>
              <BeatRow token={token} item={item} canDownload={canDownload} canComment={canComment} onDownload={() => void download(item.id)} index={index} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item, index) => (
            <li key={item.id} className="min-w-0">
              <button type="button" onClick={() => setOpen(index)} className="group block w-full text-left" aria-label={`Abrir ${item.title}`}>
                <span className="relative block aspect-[4/3] overflow-hidden rounded-card border border-line bg-tone-2">
                  {thumbs[item.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumbs[item.id]} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 size-full object-cover transition-transform duration-200 ease-ui group-hover:scale-[1.02]" />
                  ) : (
                    <span className="absolute inset-0 flex items-center justify-center text-label text-text-3">{item.kind === "video" ? "Vídeo" : item.kind === "audio" ? "Audio" : "Archivo"}</span>
                  )}
                  {item.kind === "video" ? (
                    <span className="absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-pill bg-text text-bg">
                      <PlayIcon size={14} />
                    </span>
                  ) : null}
                </span>
                <span className="mt-2 block truncate text-label text-text-2">{item.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void more()}>
            Cargar más
          </Button>
        </div>
      ) : null}

      <Modal open={open !== null} onClose={() => setOpen(null)} title={open !== null ? (items[open]?.title ?? "") : ""} className="max-w-4xl">
        {open !== null && items[open] ? (
          <Viewer
            key={items[open].id}
            token={token}
            item={items[open]}
            canDownload={canDownload}
            canComment={canComment}
            onPrev={open > 0 ? () => setOpen(open - 1) : undefined}
            onNext={open + 1 < items.length ? () => setOpen(open + 1) : undefined}
            onDownload={() => void download(items[open]?.id as string)}
          />
        ) : null}
      </Modal>
    </main>
  );
}

// --- Visor -------------------------------------------------------------------------------------------------------------

function Viewer({ token, item, canDownload, canComment, onPrev, onNext, onDownload }: { token: string; item: PublicItem; canDownload: boolean; canComment: boolean; onPrev?: () => void; onNext?: () => void; onDownload: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [round, setRound] = useState(0);
  const media = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (item.kind === "document" || item.kind === "other") return;
    let cancelled = false;
    void shareSign({ token, assetId: item.id, mode: "view" }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        setUrl(res.data.url);
        setError(false);
      } else setError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [token, item.id, item.kind, round]);

  const renew = () => {
    setUrl(null);
    setRound((n) => n + 1);
  };

  return (
    <div className="flex flex-col gap-4">
      {item.kind === "photo" && url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={item.title} referrerPolicy="no-referrer" onError={renew} className="max-h-[65vh] w-full rounded-card object-contain" />
      ) : item.kind === "video" && url ? (
        <video ref={media} src={url} controls playsInline onError={renew} className="max-h-[65vh] w-full rounded-card bg-bg" />
      ) : item.kind === "audio" && url ? (
        <audio src={url} controls onError={renew} className="w-full" />
      ) : error ? (
        <Notice variant="error">No se pudo cargar. Recarga la página.</Notice>
      ) : item.kind === "document" || item.kind === "other" ? (
        <p className="text-body text-text-2">Este archivo no tiene vista previa.{canDownload ? " Descárgalo." : ""}</p>
      ) : (
        <p className="text-label text-text-2" role="status">Cargando…</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={!onPrev} onClick={onPrev}>Anterior</Button>
          <Button size="sm" variant="ghost" disabled={!onNext} onClick={onNext}>Siguiente</Button>
        </div>
        {canDownload ? <Button size="sm" onClick={onDownload}>Descargar</Button> : null}
      </div>
      {canComment ? <Comments token={token} item={item} getTimeMs={() => (item.kind === "video" && media.current ? Math.round(media.current.currentTime * 1000) : null)} /> : null}
    </div>
  );
}

// --- Beats --------------------------------------------------------------------------------------------------------------

function BeatRow({ token, item, canDownload, canComment, onDownload, index }: { token: string; item: PublicItem; canDownload: boolean; canComment: boolean; onDownload: () => void; index: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [showComments, setShowComments] = useState(false);
  const [error, setError] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    const res = await shareSign({ token, assetId: item.id, mode: "view" });
    if (res.ok && res.data) {
      setUrl(res.data.url);
      setError(false);
    } else setError(true);
  }, [token, item.id]);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-tone-3 text-text-2">
          <MusicIcon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-medium text-text">{item.title}</p>
          <p className="truncate text-label text-text-2">{[item.beat?.bpm ? `${item.beat.bpm} BPM` : null, item.beat?.key ?? null, item.durationSeconds ? formatTimecode(item.durationSeconds * 1000) : null].filter(Boolean).join(" · ")}</p>
        </div>
        {canDownload ? <Button size="sm" variant="ghost" onClick={onDownload}>Descargar</Button> : null}
        {canComment ? <Button size="sm" variant="ghost" onClick={() => setShowComments((v) => !v)}>Comentarios</Button> : null}
      </div>
      {url ? (
        <audio ref={audio} src={url} controls autoPlay onError={() => void load()} className="w-full" aria-label={`Reproducir ${item.title}`} />
      ) : (
        <Button size="sm" onClick={() => void load()} aria-label={`Reproducir ${item.title}`} data-index={index}>
          <PlayIcon size={14} /> Escuchar
        </Button>
      )}
      {error ? <p className="text-caption text-text-2">No se pudo reproducir. Inténtalo de nuevo.</p> : null}
      {showComments ? <Comments token={token} item={item} getTimeMs={() => (audio.current ? Math.round(audio.current.currentTime * 1000) : null)} /> : null}
    </div>
  );
}

// --- Comentarios de visitante ---------------------------------------------------------------------------------------------

function Comments({ token, item, getTimeMs }: { token: string; item: PublicItem; getTimeMs: () => number | null }) {
  const [list, setList] = useState<PublicComment[] | null>(null);
  const [name, setName] = useState(() => {
    try {
      return sessionStorage.getItem("share-name") ?? "";
    } catch {
      return "";
    }
  });
  const [body, setBody] = useState("");
  const [anchor, setAnchor] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void shareComments({ token, assetId: item.id }).then((res) => {
      if (!cancelled) setList(res.ok && res.data ? res.data : []);
    });
    return () => {
      cancelled = true;
    };
  }, [token, item.id, round]);

  const submit = async () => {
    setBusy(true);
    const timecodeMs = anchor && item.kind !== "photo" ? getTimeMs() : null;
    const res = await shareAddComment({ token, assetId: item.id, name, body, timecodeMs });
    setBusy(false);
    if (!res.ok) return setMessage(res.message);
    try {
      sessionStorage.setItem("share-name", name);
    } catch {
      /* sin almacenamiento: no pasa nada */
    }
    setBody("");
    setMessage("Comentario enviado.");
    setRound((n) => n + 1);
  };

  return (
    <section aria-label="Comentarios" className="flex flex-col gap-3 border-t border-line pt-4">
      {list && list.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {list.map((c) => (
            <li key={c.id} className="rounded-control bg-tone-2 px-3 py-2 text-label">
              <p className="text-caption text-text-3">
                {c.author}
                {c.external ? " · externo" : ""}
                {c.timecodeMs !== null ? ` · ${formatTimecode(c.timecodeMs)}` : ""}
              </p>
              {/* Siempre texto: React lo escapa; nunca HTML */}
              <p className="mt-0.5 whitespace-pre-line break-words text-text">{c.body}</p>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1 text-label text-text-2">
          Tu nombre
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required className="h-9 rounded-control border border-line bg-surface px-3 text-body text-text hover:border-line-hover" />
        </label>
        <label className="flex flex-col gap-1 text-label text-text-2">
          Comentario
          <textarea value={body} maxLength={1000} rows={3} onChange={(e) => setBody(e.target.value)} required className="rounded-control border border-line bg-surface px-3 py-2 text-body text-text hover:border-line-hover" />
        </label>
        {item.kind !== "photo" ? (
          <label className="flex items-center gap-2 text-label text-text-2">
            <input type="checkbox" checked={anchor} onChange={(e) => setAnchor(e.target.checked)} className="size-4 accent-[var(--text)]" />
            Anclar al segundo actual del reproductor
          </label>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={busy || !name.trim() || !body.trim()}>
            Enviar
          </Button>
          {message ? <span className="text-label text-text-2" role="status">{message}</span> : null}
        </div>
      </form>
    </section>
  );
}

// --- ZIP ------------------------------------------------------------------------------------------------------------------

function ZipSection({ token, title }: { token: string; title: string }) {
  const [phase, setPhase] = useState<"idle" | "preparing" | "ready" | "running" | "done" | "error">("idle");
  const [parts, setParts] = useState<ZipPart[]>([]);
  const [bytes, setBytes] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const prepare = async () => {
    setPhase("preparing");
    setError(null);
    const all: PublicItem[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 40; i++) {
      const res = await shareList({ token, cursor });
      if (!res.ok || !res.data) {
        setPhase("error");
        return setError("No se pudo preparar la descarga.");
      }
      all.push(...res.data.items);
      cursor = res.data.nextCursor;
      if (!cursor) break;
    }
    const files = all.map((i) => ({ id: i.id, name: i.fileName, size: i.sizeBytes }));
    setTotal(files.reduce((n, f) => n + f.size, 0));
    setParts(planParts(files, title, supportsDirectWrite()));
    setPhase(files.length > 0 ? "ready" : "error");
    if (files.length === 0) setError("No hay archivos para descargar.");
  };

  const run = async (part: ZipPart) => {
    const abort = new AbortController();
    controller.current = abort;
    setPhase("running");
    setBytes(0);
    try {
      const sink = supportsDirectWrite() ? await openFileSink(part.fileName) : openMemorySink(part.fileName);
      await writeZipPart({
        part,
        sink,
        signal: abort.signal,
        getUrl: async (id) => {
          const res = await shareSign({ token, assetId: id, mode: "download" });
          if (!res.ok || !res.data) throw new Error(res.ok ? "sin url" : res.message);
          return res.data.url;
        },
        onBytes: (d) => setBytes((b) => b + d),
        onFile: () => undefined,
      });
      setPhase("ready");
    } catch (e) {
      if (e instanceof ZipCancelled) setPhase("ready");
      else {
        setPhase("error");
        setError("Se interrumpió la descarga. Es posible que el enlace haya alcanzado su límite.");
      }
    }
  };

  return (
    <section aria-label="Descargar todo" className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      {phase === "idle" ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-label text-text-2">Puedes descargar todo el contenido en un ZIP.</p>
          <Button size="sm" onClick={() => void prepare()}>Preparar ZIP</Button>
        </div>
      ) : phase === "preparing" ? (
        <p className="text-label text-text-2" role="status">Preparando…</p>
      ) : (
        <>
          {error ? <Notice variant="error">{error}</Notice> : null}
          {phase === "running" ? <Progress value={total > 0 ? bytes / total : 0} label="Descargando ZIP" /> : null}
          <div className="flex flex-wrap gap-2">
            {parts.map((p) => (
              <Button key={p.index} size="sm" disabled={phase === "running"} onClick={() => void run(p)}>
                {p.total > 1 ? `Parte ${p.index} de ${p.total}` : "Descargar ZIP"} · {formatBytes(p.bytes)}
              </Button>
            ))}
            {phase === "running" ? <Button size="sm" variant="ghost" onClick={() => controller.current?.abort()}>Cancelar</Button> : null}
          </div>
        </>
      )}
    </section>
  );
}
