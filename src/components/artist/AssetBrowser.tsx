"use client";

import Link from "next/link";
import { VaultMoveDialog } from "@/components/vault/VaultMoveDialog";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { getAssetUrl } from "@/app/actions/uploads";
import { getVideoStates } from "@/app/actions/video";
import type { VideoState } from "@/lib/video/jobs-types";
import {
  bulkAssets,
  getThumbUrls,
  listArtistAssets,
  listArtistFolders,
  type AssetCard,
  type AssetPage,
  type AssetTab,
  type BatchResult,
} from "@/app/actions/browse";
import { CheckIcon, DownloadIcon, ImageIcon, MusicIcon, PlayIcon, SearchIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { PhotoTile } from "@/components/ui/PhotoTile";
import { ShareDialog } from "@/components/share/ShareDialog";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";

/**
 * Listado paginado (48 por página, por cursor) de lo que hay en el espacio de un artista, con miniaturas,
 * búsqueda por nombre, selección múltiple y acciones en lote. Lo usan el admin (con publicar, mover y
 * papelera) y el portal (solo ver y descargar). Los datos llegan YA filtrados por RLS desde el servidor.
 */

export type FolderOption = { id: string; label: string; kind: string };

export type AssetBrowserProps = {
  mode: "admin" | "portal";
  artistId: string;
  tab: AssetTab;
  folderId: string | null;
  initial: AssetPage;
  /** Carpetas del artista (indentadas) para mover. */
  folders: FolderOption[];
  /** Artistas visibles para «mover a otro artista» (solo admin). */
  artists?: { id: string; name: string }[];
  /** Cosmética: qué botones se pintan. El servidor lo comprueba todo elemento a elemento. */
  can: { publish: boolean; edit: boolean };
  /** Cosmética: se ofrece «Mover al Vault» (rol con vault.upload y acceso al Vault). El servidor lo vuelve a comprobar. */
  canVault?: boolean;
  title?: string;
  emptyTitle: string;
  emptyHint?: string;
  /** Nota fija bajo el listado (p. ej. «Lo que subes queda pendiente…»). */
  footnote?: string;
  /** Ruta base de la página de cada vídeo (el portal usa la suya; el admin, la ficha `/archivo`). */
  videoBasePath?: string;
};

const KIND_ICON = {
  photo: ImageIcon,
  video: PlayIcon,
  audio: MusicIcon,
  document: ImageIcon,
  other: ImageIcon,
} as const;

const FOLDER_KIND_OF: Record<AssetCard["kind"], string> = {
  photo: "photos",
  video: "videos",
  audio: "files",
  document: "files",
  other: "files",
};

function duration(seconds: number | null): string | null {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const when = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Atlantic/Canary",
});

export function StatusBadge({ visibility }: { visibility: "private" | "published" }) {
  return visibility === "published" ? (
    <Badge variant="neutral">Visible para el artista</Badge>
  ) : (
    <Badge variant="outline">Pendiente de publicar</Badge>
  );
}

export function AssetBrowser({
  mode,
  artistId,
  tab,
  folderId,
  initial,
  folders,
  artists,
  can,
  canVault = false,
  title,
  emptyTitle,
  emptyHint,
  footnote,
  videoBasePath,
}: AssetBrowserProps) {
  const router = useRouter();
  const [items, setItems] = useState<AssetCard[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [q, setQ] = useState("");
  const [activeQ, setActiveQ] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [sharing, setSharing] = useState<"selection" | "folder" | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [moving, setMoving] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [vaulting, setVaulting] = useState(false);
  const [loading, startLoading] = useTransition();
  const [busy, startBusy] = useTransition();
  const requested = useRef(new Set<string>());
  const [videoStates, setVideoStates] = useState<Record<string, VideoState>>({});
  const stateRequested = useRef(new Set<string>());

  // Miniaturas de lo que aún no tiene: UNA llamada por tanda (se firman solo las que RLS deja ver)
  useEffect(() => {
    const photos = items.filter((i) => i.kind === "photo" && !requested.current.has(i.id)).map((i) => i.id);
    const videos = items.filter((i) => i.kind === "video" && !requested.current.has(i.id)).map((i) => i.id);
    photos.concat(videos).forEach((id) => requested.current.add(id));
    let cancelled = false;
    const merge = (res: { ok: boolean; data?: Record<string, string> }) => {
      if (!cancelled && res.ok && res.data) setThumbs((current) => ({ ...current, ...res.data }));
    };
    if (photos.length > 0) void getThumbUrls(photos).then(merge);
    // Vídeos: póster (fotograma) y estado de procesado
    if (videos.length > 0) void getThumbUrls(videos, "poster").then(merge);
    const unseen = videos.filter((id) => !stateRequested.current.has(id));
    unseen.forEach((id) => stateRequested.current.add(id));
    if (unseen.length > 0) {
      void getVideoStates(unseen).then((res) => {
        if (!cancelled && res.ok && res.data) setVideoStates((current) => ({ ...current, ...res.data }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [items]);

  const fetchPage = useCallback(
    async (after: string | null, search: string) =>
      listArtistAssets({ artistId, tab, folderId, q: search, cursor: after, portal: mode === "portal" }),
    [artistId, tab, folderId, mode],
  );

  const reload = useCallback(
    (search = activeQ) =>
      startLoading(async () => {
        const res = await fetchPage(null, search);
        if (res.ok && res.data) {
          setItems(res.data.items);
          setCursor(res.data.nextCursor);
          setSelected(new Set());
        }
      }),
    [activeQ, fetchPage],
  );

  const loadMore = () =>
    startLoading(async () => {
      const res = await fetchPage(cursor, activeQ);
      if (res.ok && res.data) {
        setItems((current) => [...current, ...res.data!.items]);
        setCursor(res.data.nextCursor);
      } else setNotice({ ok: false, message: res.ok ? "No se pudo cargar más." : res.message });
    });

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectedItems = items.filter((i) => selected.has(i.id));

  // --- Acciones ----------------------------------------------------------------------------------

  const report = (res: { ok: boolean; message?: string; data?: BatchResult }) => {
    setNotice({ ok: res.ok, message: res.message ?? (res.ok ? "Hecho." : "No se pudo completar la acción.") });
    if (res.ok) {
      reload();
      router.refresh();
    }
  };

  const bulk = (action: "publish" | "unpublish" | "trash", ids: string[]) =>
    startBusy(async () => report(await bulkAssets({ type: action, ids })));

  const downloadOne = async (id: string) => {
    const res = await getAssetUrl(id, "original", "download");
    if (!res.ok || !res.data) {
      setNotice({ ok: false, message: res.ok ? "No se pudo descargar." : res.message });
      return false;
    }
    const a = document.createElement("a");
    a.href = res.data.url; // Content-Disposition: attachment
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  };

  // Descarga en lote: una URL firmada POR archivo (el ZIP llega más adelante)
  const downloadSelected = () =>
    startBusy(async () => {
      const targets = selectedItems.filter((i) => i.downloadable);
      if (targets.length === 0) {
        setNotice({ ok: false, message: "Ninguno de los elementos elegidos se puede descargar." });
        return;
      }
      let done = 0;
      for (const item of targets) {
        if (await downloadOne(item.id)) done++;
        await new Promise((resolve) => setTimeout(resolve, 450)); // el navegador agrupa mejor las descargas escalonadas
      }
      setNotice({
        ok: done > 0,
        message: `${done} ${done === 1 ? "descarga iniciada" : "descargas iniciadas"}. Si el navegador pregunta, permite las descargas múltiples.`,
      });
    });

  // --- Vista ---------------------------------------------------------------------------------------

  return (
    <section className="flex min-w-0 flex-col gap-5" aria-label={title ?? "Archivos"}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {title ? <h2 className="text-heading text-text">{title}</h2> : <span />}
        {mode === "admin" && can.publish && folderId ? (
          <Button size="sm" variant="ghost" onClick={() => setSharing("folder")}>
            Compartir carpeta…
          </Button>
        ) : null}
        <form
          role="search"
          className="relative w-full sm:w-72"
          onSubmit={(event) => {
            event.preventDefault();
            setActiveQ(q);
            reload(q);
          }}
        >
          <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-text-3" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Buscar por nombre"
            placeholder="Buscar por nombre"
            className="h-10 w-full rounded-pill border border-line bg-surface pr-4 pl-10 text-body text-text placeholder:text-text-3 transition-colors duration-150 ease-ui hover:border-line-hover focus-visible:border-line-hover"
          />
        </form>
      </div>

      {/* Barra de acciones en lote */}
      {selected.size > 0 ? (
        <div
          role="region"
          aria-label="Acciones sobre la selección"
          className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-card border border-line-hover bg-surface px-4 py-3"
        >
          <p className="mr-auto text-label font-medium text-text">
            {selected.size} {selected.size === 1 ? "seleccionado" : "seleccionados"}
          </p>
          {mode === "portal" ? (
            <Button size="sm" onClick={downloadSelected} disabled={busy}>
              <DownloadIcon size={16} />
              Descargar selección
            </Button>
          ) : (
            <>
              {can.publish ? (
                <>
                  <Button size="sm" disabled={busy} onClick={() => bulk("publish", [...selected])}>
                    Publicar
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => bulk("unpublish", [...selected])}>
                    Despublicar
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSharing("selection")}>
                    Compartir…
                  </Button>
                </>
              ) : null}
              {can.edit ? (
                <>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMoving(true)}>
                    Mover…
                  </Button>
                  {canVault ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setVaulting(true)}>
                      Mover al Vault…
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmTrash(true)}>
                    Papelera
                  </Button>
                </>
              ) : null}
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Limpiar
          </Button>
        </div>
      ) : null}

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice variant={notice.ok ? "success" : "error"}>{notice.message}</Notice> : null}
      </div>

      {items.length === 0 && !loading ? (
        <EmptyState icon={<ImageIcon size={22} />} title={activeQ ? "Nada coincide con tu búsqueda" : emptyTitle} description={activeQ ? "Prueba con otro nombre." : emptyHint} />
      ) : (
        <ul
          className={cn(
            "grid gap-x-4 gap-y-7 transition-opacity duration-150 ease-ui",
            tab === "photos" || tab === "todo"
              ? "grid-cols-2 md:grid-cols-3 wide:grid-cols-4"
              : "grid-cols-1 sm:grid-cols-2 wide:grid-cols-3",
            loading && "opacity-60",
          )}
        >
          {items.map((item) => {
            const isSelected = selected.has(item.id);
            const Icon = KIND_ICON[item.kind];
            const length = duration(item.durationSeconds);
            return (
              <li key={item.id} className="group/card relative min-w-0">
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`${isSelected ? "Quitar de la selección" : "Seleccionar"} ${item.title}`}
                  onClick={() => toggle(item.id)}
                  className={cn(
                    "absolute top-2.5 left-2.5 z-[1] flex size-6 items-center justify-center rounded-pill border transition-[opacity,background-color,border-color] duration-150 ease-ui",
                    isSelected
                      ? "border-transparent bg-text text-bg opacity-100"
                      : "border-line-hover bg-bg text-transparent opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100",
                    selected.size > 0 && !isSelected && "opacity-100",
                  )}
                >
                  <CheckIcon size={14} strokeWidth={2.4} />
                </button>
                <PhotoTile
                  ratio={item.kind === "photo" ? "4/5" : "16/9"}
                  tone={((item.id.charCodeAt(0) % 5) + 1) as 1 | 2 | 3 | 4 | 5}
                  imageUrl={thumbs[item.id]}
                  icon={<Icon size={26} className="text-text-3" />}
                  href={item.kind === "video" && videoBasePath ? `${videoBasePath}/${item.id}` : mode === "admin" ? `/archivo/${item.id}` : undefined}
                  title={item.title}
                  meta={[
                    item.kind === "video" ? length : null,
                    item.kind !== "photo" ? formatBytes(item.sizeBytes) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || undefined}
                />
                {mode === "admin" ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <StatusBadge visibility={item.visibility} />
                      {item.kind === "video" && videoStates[item.id] && videoStates[item.id]?.status !== "ready" && videoStates[item.id]?.status !== "none" ? (
                        <Badge variant="outline">{videoStates[item.id]?.status === "failed" ? "Error al procesar" : "Procesando…"}</Badge>
                      ) : null}
                    </div>
                    <p className="truncate text-caption text-text-3">
                      {item.uploaderName ?? "—"} · {when.format(new Date(item.createdAt))}
                    </p>
                    <div className="flex gap-2">
                      {can.publish ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || (item.kind === "video" && item.visibility === "private" && !["ready", "none", undefined].includes(videoStates[item.id]?.status))}
                          onClick={() => bulk(item.visibility === "published" ? "unpublish" : "publish", [item.id])}
                        >
                          {item.visibility === "published" ? "Despublicar" : "Publicar"}
                        </Button>
                      ) : null}
                      <Link
                        href={`/archivo/${item.id}`}
                        className="inline-flex h-8 items-center rounded-pill px-2 text-label font-medium text-text-2 transition-colors duration-150 ease-ui hover:text-text"
                      >
                        Editar
                      </Link>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    {item.visibility === "private" ? <Badge variant="outline">Pendiente</Badge> : <span />}
                    {item.downloadable ? (
                      <button
                        type="button"
                        aria-label={`Descargar ${item.title}`}
                        disabled={busy}
                        onClick={() => startBusy(async () => void (await downloadOne(item.id)))}
                        className="flex size-8 items-center justify-center rounded-pill border border-line text-text-2 transition-colors duration-150 ease-ui hover:border-line-hover hover:text-text disabled:opacity-40"
                      >
                        <DownloadIcon size={16} />
                      </button>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {cursor ? (
        <div className="flex justify-center pt-2">
          <Button variant="ghost" onClick={loadMore} disabled={loading}>
            {loading ? "Cargando…" : "Cargar más"}
          </Button>
        </div>
      ) : items.length > PAGE_HINT ? (
        <p className="text-center text-caption text-text-3">Has llegado al final.</p>
      ) : null}

      {footnote ? <p className="text-caption text-text-3">{footnote}</p> : null}

      {mode === "admin" && can.publish ? (
        <ShareDialog
          open={sharing !== null}
          onClose={() => setSharing(null)}
          target={sharing === "folder" && folderId ? { kind: "folder", id: folderId } : sharing === "selection" ? { kind: "assets", ids: [...selected] } : null}
          defaultTitle={title ?? "Archivos compartidos"}
        />
      ) : null}

      {/* Mover (carpeta y/o artista) */}
      <Modal open={moving} onClose={() => setMoving(false)} title="Mover" description="Solo cambia la organización: los archivos no se vuelven a subir.">
        {moving ? (
          <MoveForm
            artistId={artistId}
            selected={selectedItems}
            folders={folders}
            artists={artists ?? []}
            busy={busy}
            onCancel={() => setMoving(false)}
            onSubmit={(destination) =>
              startBusy(async () => {
                const res = await bulkAssets({ type: "move", ids: [...selected], ...destination });
                setMoving(false);
                report(res);
              })
            }
          />
        ) : null}
      </Modal>

      {canVault ? (
        <VaultMoveDialog
          open={vaulting}
          items={selectedItems.map((i) => ({ id: i.id, name: i.title }))}
          onClose={() => setVaulting(false)}
          onDone={() => {
            setVaulting(false);
            reload();
            router.refresh();
          }}
        />
      ) : null}
      <Modal
        open={confirmTrash}
        onClose={() => setConfirmTrash(false)}
        title="Enviar a la papelera"
        description={`${selected.size} ${selected.size === 1 ? "elemento dejará" : "elementos dejarán"} de ser visibles. Se podrán restaurar desde la papelera.`}
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmTrash(false)}>
            Cancelar
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setConfirmTrash(false);
              bulk("trash", [...selected]);
            }}
          >
            Enviar a la papelera
          </Button>
        </div>
      </Modal>
    </section>
  );
}

const PAGE_HINT = 48;

// ---------------------------------------------------------------------------

function MoveForm({
  artistId,
  selected,
  folders,
  artists,
  busy,
  onCancel,
  onSubmit,
}: {
  artistId: string;
  selected: AssetCard[];
  folders: FolderOption[];
  artists: { id: string; name: string }[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (destination: { artistId: string | null; folderId: string | null }) => void;
}) {
  const [destArtist, setDestArtist] = useState(artistId);
  const [destFolder, setDestFolder] = useState("");
  const [otherFolders, setOtherFolders] = useState<FolderOption[] | null>(null);

  const kinds = new Set(selected.map((s) => FOLDER_KIND_OF[s.kind]));
  const list = (destArtist === artistId ? folders : (otherFolders ?? [])).filter(
    (f) => f.kind === "general" || (kinds.size === 1 && kinds.has(f.kind)),
  );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ artistId: destArtist, folderId: destFolder || null });
      }}
    >
      {artists.length > 1 ? (
        <Select
          label="Artista"
          value={destArtist}
          options={artists.map((a) => ({ value: a.id, label: a.name }))}
          onChange={async (e) => {
            const next = e.target.value;
            setDestArtist(next);
            setDestFolder("");
            setOtherFolders(null);
            if (next !== artistId) {
              const res = await listArtistFolders(next);
              if (res.ok && res.data) setOtherFolders(res.data);
              else setOtherFolders([]);
            }
          }}
        />
      ) : null}
      <Select
        label="Carpeta"
        value={destFolder}
        options={[{ value: "", label: "Sin carpeta (raíz)" }, ...list.map((f) => ({ value: f.id, label: f.label }))]}
        onChange={(e) => setDestFolder(e.target.value)}
      />
      {kinds.size > 1 ? (
        <p className="text-caption text-text-3">
          Has elegido tipos distintos: solo se ofrecen carpetas generales. Para usar Fotos, Vídeos o Archivos, mueve cada tipo por separado.
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={busy}>
          Mover {selected.length === 1 ? "1 elemento" : `${selected.length} elementos`}
        </Button>
      </div>
    </form>
  );
}
