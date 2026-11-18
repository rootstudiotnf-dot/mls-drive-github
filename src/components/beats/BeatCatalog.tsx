"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBeatDownloadUrl, listBeats, type BeatPage } from "@/app/actions/beats";
import { getThumbUrls } from "@/app/actions/browse";
import { DownloadIcon, MusicIcon, PauseIcon, PlayIcon, SearchIcon } from "@/components/icons";
import { usePlayer } from "@/components/player/PlayerProvider";
import { Badge } from "@/components/ui/Badge";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";
import { filtersToParams, formatDuration, MUSICAL_KEYS, type BeatOrder, type BeatRow, type CatalogFilters } from "@/lib/beats/types";
import { VirtualList } from "./VirtualList";

type Option = { id: string; name: string };

const ORDER_LABEL: Record<BeatOrder, string> = { recent: "Más recientes", name: "Nombre", bpm: "BPM" };

/**
 * Catálogo de beats: búsqueda de texto completo, filtros (género, BPM, tonalidad, etiquetas, estado, artista), orden,
 * vista lista/cuadrícula, paginación por cursor (50) con desplazamiento infinito y virtualización.
 * Lo que cada persona ve lo decide la base de datos; aquí solo se pintan los resultados.
 */
export function BeatCatalog({
  mode,
  initialFilters,
  initialPage,
  genres,
  tags,
  artists,
  basePath,
}: {
  mode: "admin" | "portal";
  initialFilters: CatalogFilters;
  initialPage: BeatPage;
  genres: Option[];
  tags: Option[];
  artists: Option[];
  basePath: string;
}) {
  const player = usePlayer();
  const [filters, setFilters] = useState<CatalogFilters>(initialFilters);
  const [items, setItems] = useState<BeatRow[]>(initialPage.items);
  const [cursor, setCursor] = useState<string | null>(initialPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState(initialFilters.q ?? "");
  const requested = useRef(new Set<string>());
  const generation = useRef(0);
  const view = filters.view === "grid" ? "grid" : "list";

  // Portadas por lotes (una llamada por tanda); se firman solo las que RLS deja ver
  useEffect(() => {
    const missing = items.map((i) => i.coverAssetId).filter((id): id is string => !!id && !requested.current.has(id));
    if (missing.length === 0) return;
    missing.forEach((id) => requested.current.add(id));
    let cancelled = false;
    for (let i = 0; i < missing.length; i += 50) {
      void getThumbUrls(missing.slice(i, i + 50)).then((res) => {
        if (!cancelled && res.ok && res.data) setCovers((c) => ({ ...c, ...res.data }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [items]);

  const apply = useCallback(
    async (next: CatalogFilters) => {
      setFilters(next);
      const params = filtersToParams(next).toString();
      window.history.replaceState(window.history.state, "", params ? `${basePath}?${params}` : basePath);
      const mine = ++generation.current;
      setLoading(true);
      const res = await listBeats({ filters: next });
      if (mine !== generation.current) return;
      setLoading(false);
      if (res.ok && res.data) {
        setItems(res.data.items);
        setCursor(res.data.nextCursor);
      }
    },
    [basePath],
  );

  // La búsqueda de texto espera 300 ms tras dejar de escribir
  useEffect(() => {
    if ((filters.q ?? "") === text.trim()) return;
    const timer = setTimeout(() => void apply({ ...filters, q: text.trim() || undefined }), 300);
    return () => clearTimeout(timer);
  }, [text, filters, apply]);

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;
    const mine = generation.current;
    setLoading(true);
    const res = await listBeats({ filters, cursor });
    if (mine !== generation.current) return;
    setLoading(false);
    if (res.ok && res.data) {
      setItems((current) => [...current, ...res.data!.items.filter((n) => !current.some((c) => c.id === n.id))]);
      setCursor(res.data.nextCursor);
    }
  }, [cursor, loading, filters]);

  const toggle = <K extends "genres" | "keys" | "tags">(key: K, value: string) => {
    const current = (filters[key] as string[] | undefined) ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    void apply({ ...filters, [key]: next.length ? next : undefined });
  };

  const tracks = useMemo(() => items.map((i) => ({ id: i.id, title: i.title })), [items]);
  const playing = player.track?.id;

  const play = (beat: BeatRow, index: number) => {
    if (playing === beat.id) player.toggle();
    else if (beat.previewReady) player.playQueue(tracks, index);
    else setNotice("Este beat aún no tiene preview.");
  };

  const download = async (beat: BeatRow) => {
    const res = await getBeatDownloadUrl(beat.id);
    if (!res.ok || !res.data) return setNotice(res.ok ? "No se pudo descargar." : res.message);
    const a = document.createElement("a");
    a.href = res.data.url; // attachment con el título del beat
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const canDownloadHint = (beat: BeatRow) => beat.downloadable && (mode === "admin" || beat.sharedWith.some((s) => s.canDownload));

  const PlayButton = ({ beat, index, className }: { beat: BeatRow; index: number; className?: string }) => (
    <button
      type="button"
      aria-label={playing === beat.id && player.playing ? `Pausar ${beat.title}` : `Reproducir ${beat.title}`}
      onClick={() => play(beat, index)}
      disabled={!beat.previewReady}
      className={cn("flex size-10 shrink-0 items-center justify-center rounded-pill bg-text text-bg transition-colors duration-150 ease-ui hover:bg-text-2 disabled:opacity-30", className)}
    >
      {playing === beat.id && player.playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
    </button>
  );

  const Cover = ({ beat, size }: { beat: BeatRow; size: string }) => (
    <span className={cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-control border border-line bg-tone-2", size)}>
      {beat.coverAssetId && covers[beat.coverAssetId] ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={covers[beat.coverAssetId]} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
      ) : (
        <MusicIcon size={20} className="text-text-3" />
      )}
    </span>
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Búsqueda y orden */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div role="search" className="relative w-full md:max-w-sm">
          <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-text-3" />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Buscar beats"
            placeholder="Buscar por título, género o etiqueta"
            className="h-10 w-full rounded-pill border border-line bg-surface pr-4 pl-10 text-body text-text placeholder:text-text-3 transition-colors duration-150 ease-ui hover:border-line-hover focus-visible:border-line-hover"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 md:ml-auto">
          <div className="w-40">
            <Select
              aria-label="Ordenar"
              value={filters.order ?? "recent"}
              onChange={(e) => void apply({ ...filters, order: e.target.value as BeatOrder })}
              options={(Object.keys(ORDER_LABEL) as BeatOrder[]).map((o) => ({ value: o, label: ORDER_LABEL[o] }))}
            />
          </div>
          <div role="group" aria-label="Vista" className="flex gap-1.5">
            <Chip selected={view === "list"} onClick={() => void apply({ ...filters, view: "list" })}>
              Lista
            </Chip>
            <Chip selected={view === "grid"} onClick={() => void apply({ ...filters, view: "grid" })}>
              Portadas
            </Chip>
          </div>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-col gap-3">
        {genres.length > 0 ? (
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 py-1" role="group" aria-label="Filtrar por género">
            {genres.map((g) => (
              <Chip key={g.id} selected={filters.genres?.includes(g.id) ?? false} onClick={() => toggle("genres", g.id)}>
                {g.name}
              </Chip>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-caption text-text-3">
            BPM
            <input
              type="number"
              inputMode="numeric"
              aria-label="BPM mínimo"
              placeholder="mín."
              defaultValue={filters.bpmMin ?? ""}
              onBlur={(e) => void apply({ ...filters, bpmMin: e.target.value ? Number(e.target.value) : undefined })}
              className="h-8 w-20 rounded-control border border-line bg-surface px-2 text-label text-text hover:border-line-hover"
            />
            –
            <input
              type="number"
              inputMode="numeric"
              aria-label="BPM máximo"
              placeholder="máx."
              defaultValue={filters.bpmMax ?? ""}
              onBlur={(e) => void apply({ ...filters, bpmMax: e.target.value ? Number(e.target.value) : undefined })}
              className="h-8 w-20 rounded-control border border-line bg-surface px-2 text-label text-text hover:border-line-hover"
            />
          </label>
          <details className="group relative">
            <summary className="flex h-8 cursor-pointer list-none items-center rounded-pill border border-line px-3.5 text-label font-medium text-text-2 hover:border-line-hover">
              Tonalidad{filters.keys?.length ? ` · ${filters.keys.length}` : ""}
            </summary>
            <div className="absolute z-20 mt-2 flex w-72 flex-wrap gap-1.5 rounded-card border border-line-hover bg-surface p-3">
              {MUSICAL_KEYS.map((k) => (
                <Chip key={k} selected={filters.keys?.includes(k) ?? false} onClick={() => toggle("keys", k)}>
                  {k}
                </Chip>
              ))}
            </div>
          </details>
          {tags.length > 0 ? (
            <div className="w-44">
              <Select
                aria-label="Etiqueta"
                value={filters.tags?.[0] ?? ""}
                onChange={(e) => void apply({ ...filters, tags: e.target.value ? [e.target.value] : undefined })}
                options={[{ value: "", label: "Todas las etiquetas" }, ...tags.map((t) => ({ value: t.id, label: t.name }))]}
              />
            </div>
          ) : null}
          {mode === "admin" ? (
            <>
              <div role="group" aria-label="Estado" className="flex gap-1.5">
                {([undefined, "draft", "published"] as const).map((s) => (
                  <Chip key={s ?? "todos"} selected={filters.status === s} onClick={() => void apply({ ...filters, status: s })}>
                    {s === "draft" ? "Borrador" : s === "published" ? "Publicado" : "Todos"}
                  </Chip>
                ))}
              </div>
              {artists.length > 0 ? (
                <div className="w-44">
                  <Select
                    aria-label="Artista con acceso"
                    value={filters.artist ?? ""}
                    onChange={(e) => void apply({ ...filters, artist: e.target.value || undefined })}
                    options={[{ value: "", label: "Todos los artistas" }, ...artists.map((a) => ({ value: a.id, label: a.name }))]}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      <p className="text-caption text-text-3" aria-live="polite">
        {notice ?? (loading ? "Cargando…" : `${items.length}${cursor ? "+" : ""} ${items.length === 1 ? "beat" : "beats"}`)}
      </p>

      {items.length === 0 && !loading ? (
        <EmptyState
          icon={<MusicIcon size={22} />}
          title={mode === "portal" ? "Todavía no hay beats para ti" : "No hay beats con esos filtros"}
          description={mode === "portal" ? "Cuando se compartan beats contigo, aparecerán aquí." : "Prueba con otra búsqueda o quita algún filtro."}
        />
      ) : view === "list" ? (
        <VirtualList
          label="Beats"
          items={items}
          rowHeight={72}
          getKey={(b) => b.id}
          onNearEnd={() => void loadMore()}
          extraHeight={cursor ? 48 : 0}
          render={(beat, index) => (
            <div className={cn("flex h-[72px] items-center gap-3 rounded-card border border-transparent px-2 transition-colors duration-150 ease-ui hover:border-line hover:bg-surface sm:gap-4 sm:px-3", playing === beat.id && "border-line bg-surface")}>
              <PlayButton beat={beat} index={index} />
              <Cover beat={beat} size="size-12" />
              <div className="min-w-0 flex-1">
                {mode === "admin" ? (
                  <Link href={`/beats/${beat.id}`} className="block truncate rounded-control text-body font-medium text-text hover:underline">
                    {beat.title}
                  </Link>
                ) : (
                  <p className="truncate text-body font-medium text-text">{beat.title}</p>
                )}
                <p className="truncate text-label text-text-2">
                  {[beat.genre, beat.bpm ? `${beat.bpm} BPM` : null, beat.key, formatDuration(beat.durationSeconds)].filter(Boolean).join(" · ")}
                </p>
              </div>
              <div className="hidden min-w-0 max-w-56 shrink md:block">
                {mode === "admin" ? (
                  <p className="truncate text-label text-text-3">{beat.sharedWith.length > 0 ? `Con ${beat.sharedWith.map((s) => s.name).join(", ")}` : "Sin compartir"}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {mode === "admin" ? <Badge variant={beat.status === "published" ? "neutral" : "outline"}>{beat.status === "published" ? "Publicado" : "Borrador"}</Badge> : null}
                {canDownloadHint(beat) ? (
                  <button
                    type="button"
                    aria-label={`Descargar ${beat.title}`}
                    onClick={() => void download(beat)}
                    className="flex size-9 items-center justify-center rounded-pill border border-line text-text-2 transition-colors duration-150 ease-ui hover:border-line-hover hover:text-text"
                  >
                    <DownloadIcon size={16} />
                  </button>
                ) : mode === "portal" ? (
                  <span className="text-caption text-text-3">Solo escuchar</span>
                ) : null}
              </div>
            </div>
          )}
        />
      ) : (
        <VirtualList
          label="Beats"
          items={items}
          minColumnWidth={170}
          gap={16}
          rowHeight={(w) => w + 76}
          getKey={(b) => b.id}
          onNearEnd={() => void loadMore()}
          extraHeight={cursor ? 48 : 0}
          render={(beat, index, box) => (
            <div className="flex h-full flex-col gap-2">
              <div className="relative" style={{ width: box.width, height: box.width }}>
                <Cover beat={beat} size="size-full" />
                <PlayButton beat={beat} index={index} className="absolute right-2 bottom-2" />
              </div>
              <div className="min-w-0">
                {mode === "admin" ? (
                  <Link href={`/beats/${beat.id}`} className="block truncate rounded-control text-body font-medium text-text hover:underline">
                    {beat.title}
                  </Link>
                ) : (
                  <p className="truncate text-body font-medium text-text">{beat.title}</p>
                )}
                <p className="truncate text-label text-text-2">{[beat.bpm ? `${beat.bpm} BPM` : null, beat.key, beat.genre].filter(Boolean).join(" · ")}</p>
              </div>
            </div>
          )}
        />
      )}
    </div>
  );
}
