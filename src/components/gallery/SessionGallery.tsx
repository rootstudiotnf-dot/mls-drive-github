"use client";

import { VaultMoveDialog } from "@/components/vault/VaultMoveDialog";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { bulkAssets, type BatchResult } from "@/app/actions/browse";
import {
  listSessionPhotos,
  reorderSessionPhotos,
  setFavorite,
  setSessionCover,
} from "@/app/actions/sessions";
import { getAssetUrl } from "@/app/actions/uploads";
import { CheckIcon, DownloadIcon, HeartIcon, ImageIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { ShareDialog } from "@/components/share/ShareDialog";
import { Select } from "@/components/ui/Select";
import { variantAllowed, type DownloadMode } from "@/lib/assets/variants";
import { cn } from "@/lib/cn";
import { sortPhotos, type SessionFolder, type SessionPhoto, type SortMode } from "@/lib/sessions/types";
import { JustifiedGrid } from "./JustifiedGrid";
import { PhotoViewer } from "./PhotoViewer";
import { useImageUrls } from "./useImageUrls";
import { ZipDownloadDialog } from "./ZipDownloadDialog";

export type GalleryProps = {
  mode: "admin" | "portal";
  session: { id: string; name: string; downloadMode: DownloadMode; coverAssetId: string | null };
  initialPhotos: SessionPhoto[];
  truncated: boolean;
  folders: SessionFolder[];
  /** Otras sesiones a las que se pueden mover fotos (admin). */
  moveTargets: { id: string; name: string }[];
  /** Cosmética: el servidor comprueba cada acción. */
  can: { edit: boolean; publish: boolean };
  /** Cosmética: se ofrece «Mover al Vault» (el servidor lo vuelve a comprobar). */
  canVault?: boolean;
  initialFavorites: string[];
  initialPhotoId: string | null;
  /** Ruta de la página (sin query), para el parámetro ?foto=. */
  pathname: string;
};

type Dialog = null | "trash" | "move-folder" | "move-session";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "manual", label: "Orden manual" },
  { value: "name", label: "Por nombre" },
  { value: "date", label: "Por fecha de subida" },
];

export function SessionGallery({
  mode,
  session,
  initialPhotos,
  truncated,
  folders,
  moveTargets,
  can,
  canVault = false,
  initialFavorites,
  initialPhotoId,
  pathname,
}: GalleryProps) {
  const router = useRouter();
  const [photos, setPhotos] = useState(initialPhotos);
  const [sort, setSort] = useState<SortMode>("manual");
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [onlyFavs, setOnlyFavs] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(new Set(initialFavorites));
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [viewerId, setViewerId] = useState<string | null>(initialPhotoId && initialPhotos.some((p) => p.id === initialPhotoId) ? initialPhotoId : null);
  const [zip, setZip] = useState<{ ids: string[] | null; count: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sharing, setSharing] = useState(false);
  const [vaulting, setVaulting] = useState(false);
  const [target, setTarget] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();
  const { urls: thumbs, ensure } = useImageUrls("thumb");
  const draggingId = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const admin = mode === "admin";
  const downloadAllowed = session.downloadMode !== "off";
  const preferredVariant = variantAllowed(session.downloadMode, "original") ? "original" : "web";

  // Carga diferida: solo se piden miniaturas de lo que está cerca de la pantalla (IntersectionObserver)
  const observer = useMemo(
    () =>
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              const ids = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.photo as string);
              if (ids.length > 0) ensure(ids);
            },
            { rootMargin: "600px 0px" },
          ),
    [ensure],
  );
  useEffect(() => () => observer?.disconnect(), [observer]);

  // --- Lista visible ----------------------------------------------------------------------------------
  const displayed = useMemo(() => {
    let list = photos;
    if (folderFilter) list = list.filter((p) => p.folderId === folderFilter);
    if (onlyFavs) list = list.filter((p) => favorites.has(p.id));
    return sortPhotos(list, sort);
  }, [photos, folderFilter, onlyFavs, favorites, sort]);

  const reorderable = admin && can.edit && sort === "manual" && !folderFilter && !onlyFavs;
  const downloadable = displayed.filter((p) => p.downloadable);

  // --- ?foto=<id> ---------------------------------------------------------------------------------------
  const setUrl = useCallback(
    (id: string | null) => {
      const url = id ? `${pathname}?foto=${encodeURIComponent(id)}` : pathname;
      window.history.replaceState(window.history.state, "", url);
    },
    [pathname],
  );
  const openViewer = (id: string) => {
    setViewerId(id);
    setUrl(id);
  };
  const closeViewer = useCallback(() => {
    setViewerId(null);
    setUrl(null);
  }, [setUrl]);

  // --- Selección ---------------------------------------------------------------------------------------
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelection = () => {
    setSelected(new Set());
    setSelecting(false);
  };

  // --- Favoritas -----------------------------------------------------------------------------------------
  const toggleFavorite = (photo: SessionPhoto) => {
    const wasFav = favorites.has(photo.id);
    setFavorites((current) => {
      const next = new Set(current);
      if (wasFav) next.delete(photo.id);
      else next.add(photo.id);
      return next;
    });
    void setFavorite(photo.id, !wasFav).then((res) => {
      if (!res.ok) {
        setFavorites((current) => {
          const next = new Set(current);
          if (wasFav) next.add(photo.id);
          else next.delete(photo.id);
          return next;
        });
        setNotice({ ok: false, message: res.message });
      }
    });
  };

  // --- Descarga individual ----------------------------------------------------------------------------------
  const downloadOne = async (photo: SessionPhoto) => {
    const res = await getAssetUrl(photo.id, preferredVariant, "download");
    if (!res.ok || !res.data) {
      setNotice({ ok: false, message: res.ok ? "No se pudo descargar." : res.message });
      return;
    }
    const a = document.createElement("a");
    a.href = res.data.url; // Content-Disposition: attachment
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // --- Acciones de administración -------------------------------------------------------------------------------
  const reload = async () => {
    const res = await listSessionPhotos({ sessionId: session.id, portal: !admin });
    if (res.ok && res.data) setPhotos(res.data.photos);
    router.refresh();
  };

  const report = (res: { ok: boolean; message?: string; data?: BatchResult }) => {
    setNotice({ ok: res.ok, message: res.message ?? (res.ok ? "Hecho." : "No se pudo completar la acción.") });
    if (res.ok) {
      setSelected(new Set());
      void reload();
    }
  };

  const bulk = (action: "publish" | "unpublish" | "trash") =>
    startBusy(async () => report(await bulkAssets({ type: action, ids: [...selected] })));

  const moveTo = (kind: "folder" | "session") =>
    startBusy(async () => {
      const res =
        kind === "folder"
          ? await bulkAssets({ type: "session-move", ids: [...selected], sessionId: session.id, folderId: target || null })
          : await bulkAssets({ type: "session-move", ids: [...selected], sessionId: target, folderId: null });
      setDialog(null);
      report(res);
    });

  const makeCover = () =>
    startBusy(async () => {
      const id = [...selected][0];
      if (!id) return;
      const res = await setSessionCover(session.id, id);
      setNotice({ ok: res.ok, message: res.message ?? (res.ok ? "Portada actualizada." : "No se pudo cambiar la portada.") });
      if (res.ok) {
        setSelected(new Set());
        router.refresh();
      }
    });

  // --- Orden manual (arrastrar) -----------------------------------------------------------------------------------
  const applyOrder = (ids: string[]) => {
    const position = new Map(ids.map((id, i) => [id, i]));
    setPhotos((current) => current.map((p) => ({ ...p, sortIndex: position.get(p.id) ?? p.sortIndex })));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void reorderSessionPhotos(session.id, ids).then((res) => {
        setNotice({ ok: res.ok, message: res.ok ? "Orden guardado." : res.message });
        if (!res.ok) void reload();
      });
    }, 500);
  };

  const dropOn = (targetId: string) => {
    const dragged = draggingId.current;
    draggingId.current = null;
    setDragOver(null);
    if (!dragged || dragged === targetId) return;
    const order = displayed.map((p) => p.id); // orden manual completo (sin filtros: reorderable lo garantiza)
    const moving = selected.has(dragged) ? order.filter((id) => selected.has(id)) : [dragged];
    if (moving.includes(targetId)) return;
    const originalTarget = order.indexOf(targetId);
    const firstMoving = order.indexOf(moving[0] as string);
    const rest = order.filter((id) => !moving.includes(id));
    const at = rest.indexOf(targetId) + (firstMoving < originalTarget ? 1 : 0);
    rest.splice(at, 0, ...moving);
    applyOrder(rest);
  };

  // --- Tile -----------------------------------------------------------------------------------------------------------
  const renderTile = (photo: SessionPhoto, box: { width: number; height: number }) => {
    const isSelected = selected.has(photo.id);
    const fav = favorites.has(photo.id);
    const url = thumbs[photo.id];
    const showCheck = admin || selecting;
    const isCover = session.coverAssetId === photo.id;
    return (
      <div
        data-photo={photo.id}
        ref={(el) => {
          if (!el || !observer) return;
          observer.observe(el);
          return () => observer.unobserve(el);
        }}
        draggable={reorderable}
        onDragStart={(event) => {
          draggingId.current = photo.id;
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => {
          if (reorderable && draggingId.current) {
            event.preventDefault();
            setDragOver(photo.id);
          }
        }}
        onDragLeave={() => setDragOver((current) => (current === photo.id ? null : current))}
        onDrop={(event) => {
          event.preventDefault();
          dropOn(photo.id);
        }}
        onDragEnd={() => {
          draggingId.current = null;
          setDragOver(null);
        }}
        className={cn(
          "group/tile relative size-full overflow-hidden rounded-control bg-tone-2",
          isSelected && "outline-2 outline-offset-[-2px] outline-text",
          dragOver === photo.id && "outline-2 outline-offset-[-2px] outline-line-hover",
        )}
        style={{ backgroundColor: photo.avgColor ?? undefined, width: box.width, height: box.height }}
      >
        <button
          type="button"
          aria-label={`${selecting || (admin && selected.size > 0) ? (isSelected ? "Quitar de la selección: " : "Seleccionar: ") : "Abrir "}${photo.title}`}
          onClick={() => (selecting || (admin && selected.size > 0) ? toggle(photo.id) : openViewer(photo.id))}
          className="absolute inset-0 block size-full"
        >
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt=""
              width={photo.width ?? undefined}
              height={photo.height ?? undefined}
              decoding="async"
              draggable={false}
              ref={(el) => {
                if (el?.complete && el.naturalWidth > 0) el.classList.remove("opacity-0"); // en caché: ya está listo
              }}
              onLoad={(event) => event.currentTarget.classList.remove("opacity-0")}
              onError={() => ensure([photo.id], true)}
              className="size-full object-cover opacity-0 transition-opacity duration-200 ease-ui motion-reduce:transition-none"
            />
          ) : (
            <span className="flex size-full items-center justify-center text-text-3">
              <ImageIcon size={22} />
            </span>
          )}
        </button>

        {showCheck ? (
          <button
            type="button"
            aria-pressed={isSelected}
            aria-label={`${isSelected ? "Quitar de la selección" : "Seleccionar"} ${photo.title}`}
            onClick={() => toggle(photo.id)}
            className={cn(
              "absolute top-2 left-2 flex size-6 items-center justify-center rounded-pill border transition-[opacity,background-color] duration-150 ease-ui",
              isSelected
                ? "border-transparent bg-text text-bg opacity-100"
                : "border-line-hover bg-bg text-transparent opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100 max-sm:opacity-100",
              (selecting || selected.size > 0) && !isSelected && "opacity-100",
            )}
          >
            <CheckIcon size={14} strokeWidth={2.4} />
          </button>
        ) : null}

        <button
          type="button"
          aria-pressed={fav}
          aria-label={fav ? `Quitar de favoritas: ${photo.title}` : `Marcar como favorita: ${photo.title}`}
          onClick={() => toggleFavorite(photo)}
          className={cn(
            "absolute top-2 right-2 flex size-8 items-center justify-center rounded-pill bg-bg text-text transition-opacity duration-150 ease-ui",
            fav ? "opacity-100" : "opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100 max-sm:opacity-100",
          )}
        >
          <HeartIcon size={16} fill={fav ? "currentColor" : "none"} />
        </button>

        {admin && (photo.visibility === "private" || isCover) ? (
          <span className="pointer-events-none absolute bottom-2 left-2 flex gap-1">
            {photo.visibility === "private" ? <Badge variant="outline">Pendiente</Badge> : null}
            {isCover ? <Badge variant="solid">Portada</Badge> : null}
          </span>
        ) : null}
      </div>
    );
  };

  // --- Vista --------------------------------------------------------------------------------------------------------------
  const viewerIndex = viewerId ? displayed.findIndex((p) => p.id === viewerId) : -1;
  const selectedCount = selected.size;

  return (
    <section className="flex min-w-0 flex-col gap-5" aria-label="Fotos de la sesión">
      <div className="flex flex-wrap items-center gap-2">
        {admin && folders.length > 0 ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por carpeta">
            <Chip selected={folderFilter === null} onClick={() => setFolderFilter(null)}>
              Todas
            </Chip>
            {folders.map((f) => (
              <Chip key={f.id} selected={folderFilter === f.id} onClick={() => setFolderFilter(f.id)}>
                {f.name} · {f.photos}
              </Chip>
            ))}
          </div>
        ) : null}
        <Chip selected={onlyFavs} onClick={() => setOnlyFavs((v) => !v)}>
          Solo favoritas{favorites.size > 0 ? ` · ${favorites.size}` : ""}
        </Chip>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {admin ? (
            <div className="w-48">
              <Select aria-label="Ordenar fotos" value={sort} onChange={(e) => setSort(e.target.value as SortMode)} options={SORT_OPTIONS} />
            </div>
          ) : null}
          {!admin ? (
            <Button size="sm" variant="ghost" onClick={() => (selecting ? clearSelection() : setSelecting(true))}>
              {selecting ? "Cancelar selección" : "Seleccionar"}
            </Button>
          ) : null}
          {downloadAllowed && downloadable.length > 0 ? (
            <Button size="sm" onClick={() => setZip({ ids: null, count: photos.filter((p) => p.downloadable).length })}>
              <DownloadIcon size={16} />
              Descargar todo
            </Button>
          ) : null}
        </div>
      </div>

      {!downloadAllowed ? (
        <p className="text-caption text-text-3">
          {admin ? "La descarga está desactivada para esta sesión." : "El equipo no ha activado la descarga para esta sesión. Puedes verla y marcar tus favoritas."}
        </p>
      ) : null}
      {reorderable ? <p className="text-caption text-text-3">Arrastra las fotos para ordenarlas a mano.</p> : null}
      {truncated ? <Notice variant="info">Se muestran las primeras 2000 fotos de la sesión.</Notice> : null}

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice variant={notice.ok ? "success" : "error"}>{notice.message}</Notice> : null}
      </div>

      {displayed.length === 0 ? (
        <EmptyState
          icon={<ImageIcon size={22} />}
          title={onlyFavs ? "Aún no tienes favoritas" : folderFilter ? "Esta carpeta está vacía" : "Todavía no hay fotos"}
          description={onlyFavs ? "Pulsa el corazón de una foto para guardarla aquí." : admin ? "Sube fotos a la sesión y aparecerán aquí." : "Cuando se publiquen fotos de la sesión, las verás aquí."}
        />
      ) : (
        <JustifiedGrid photos={displayed} renderTile={renderTile} />
      )}

      {canVault ? (
        <VaultMoveDialog
          open={vaulting}
          items={photos.filter((p) => selected.has(p.id)).map((p) => ({ id: p.id, name: p.title }))}
          onClose={() => setVaulting(false)}
          onDone={() => {
            setVaulting(false);
            setPhotos((current) => current.filter((p) => !selected.has(p.id)));
            setSelected(new Set());
            router.refresh();
          }}
        />
      ) : null}

      {/* Barra de acciones: administración */}
      {admin && selectedCount > 0 ? (
        <div role="region" aria-label="Acciones sobre la selección" className="sticky bottom-4 z-10 mx-auto flex max-w-full flex-wrap items-center gap-2 rounded-card border border-line-hover bg-surface px-4 py-3">
          <p className="mr-2 text-label font-medium text-text">
            {selectedCount} {selectedCount === 1 ? "seleccionada" : "seleccionadas"}
          </p>
          {can.publish ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => bulk("publish")}>
                Publicar
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => bulk("unpublish")}>
                Despublicar
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSharing(true)}>
                Compartir…
              </Button>
            </>
          ) : null}
          {can.edit ? (
            <>
              {folders.length > 0 ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setTarget(""); setDialog("move-folder"); }}>
                  A carpeta…
                </Button>
              ) : null}
              {moveTargets.length > 0 ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setTarget(moveTargets[0]?.id ?? ""); setDialog("move-session"); }}>
                  A otra sesión…
                </Button>
              ) : null}
              {selectedCount === 1 ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={makeCover}>
                  Marcar como portada
                </Button>
              ) : null}
              {canVault ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setVaulting(true)}>
                  Mover al Vault…
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDialog("trash")}>
                Papelera
              </Button>
            </>
          ) : null}
          {downloadAllowed ? (
            <Button size="sm" variant="ghost" onClick={() => setZip({ ids: [...selected], count: selectedCount })}>
              Descargar
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            Limpiar
          </Button>
        </div>
      ) : null}

      {/* Barra flotante del portal: sólida, sin transparencia */}
      {!admin && selecting ? (
        <div role="region" aria-label="Selección" className="fixed bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-pill border border-line-hover bg-surface py-2 pr-2 pl-5">
          <p className="text-label font-medium whitespace-nowrap text-text">
            {selectedCount} {selectedCount === 1 ? "seleccionada" : "seleccionadas"}
            {downloadAllowed ? " · " : ""}
          </p>
          {downloadAllowed ? (
            <Button size="sm" disabled={selectedCount === 0} onClick={() => setZip({ ids: [...selected], count: selectedCount })}>
              <DownloadIcon size={16} />
              Descargar
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            Cancelar
          </Button>
        </div>
      ) : null}

      {viewerIndex >= 0 ? (
        <PhotoViewer
          photos={displayed}
          index={viewerIndex}
          thumbUrls={thumbs}
          favorites={favorites}
          canDownload={(p) => downloadAllowed && p.downloadable}
          downloadLabel={preferredVariant === "original" ? "Descargar original" : "Descargar versión web"}
          onClose={closeViewer}
          onIndex={(next) => openViewer((displayed[next] as SessionPhoto).id)}
          onFavorite={toggleFavorite}
          onDownload={(p) => void downloadOne(p)}
          canComment
        />
      ) : null}

      {zip ? (
        <ZipDownloadDialog
          open
          onClose={() => setZip(null)}
          sessionId={session.id}
          sessionName={session.name}
          downloadMode={session.downloadMode}
          ids={zip.ids}
          count={zip.count}
        />
      ) : null}

      {admin && can.publish ? <ShareDialog open={sharing} onClose={() => setSharing(false)} target={sharing ? { kind: "assets", ids: [...selected] } : null} defaultTitle={session.name} /> : null}
      <Modal open={dialog === "trash"} onClose={() => setDialog(null)} title="Enviar a la papelera" description={`${selectedCount} ${selectedCount === 1 ? "foto dejará" : "fotos dejarán"} de ser visibles. Se podrán restaurar desde la papelera del artista.`}>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialog(null)}>
            Cancelar
          </Button>
          <Button disabled={busy} onClick={() => { setDialog(null); bulk("trash"); }}>
            Enviar a la papelera
          </Button>
        </div>
      </Modal>

      <Modal open={dialog === "move-folder"} onClose={() => setDialog(null)} title="Mover a una carpeta" description="Solo cambia la organización dentro de la sesión.">
        <div className="flex flex-col gap-4">
          <Select label="Carpeta" value={target} onChange={(e) => setTarget(e.target.value)} options={[{ value: "", label: "Sin carpeta" }, ...folders.map((f) => ({ value: f.id, label: f.name }))]} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button disabled={busy} onClick={() => moveTo("folder")}>
              Mover
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={dialog === "move-session"} onClose={() => setDialog(null)} title="Mover a otra sesión" description="Las fotos pasan a la sesión elegida (y a su artista, si es otro).">
        <div className="flex flex-col gap-4">
          <Select label="Sesión" value={target} onChange={(e) => setTarget(e.target.value)} options={moveTargets.map((s) => ({ value: s.id, label: s.name }))} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button disabled={busy || !target} onClick={() => moveTo("session")}>
              Mover
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
