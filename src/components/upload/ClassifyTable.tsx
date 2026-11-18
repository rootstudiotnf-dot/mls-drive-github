"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { formatBytes } from "@/lib/format";
import { UI_TYPE_LABEL, UI_TO_CLASS, type UiType } from "@/lib/storage/validate";
import type { UploadItem } from "./useUploader";

export type FolderOption = { id: string; artistId: string; name: string; kind: string };

export type ClassifyTableProps = {
  items: UploadItem[];
  artists: { id: string; name: string }[];
  folders: FolderOption[];
  /** Tipos que el rol puede subir (cosmética: el servidor lo vuelve a comprobar). */
  allowedTypes: Record<UiType, boolean>;
  /** Tipos que el rol puede publicar: sin permiso, «Visible para» queda en «Solo yo». */
  publishableTypes: Record<UiType, boolean>;
  /** Roles con alcance «todos»: pueden subir beats sin artista (biblioteca de beats). */
  canUploadWithoutArtist: boolean;
  onChange: (id: string, changes: Partial<Pick<UploadItem, "type" | "artistId" | "folderId" | "visibility">>) => void;
  onApplyAll: (changes: Partial<Pick<UploadItem, "artistId" | "folderId" | "visibility">>) => void;
  onRemove: (id: string) => void;
};

const FOLDER_KIND_FOR: Record<string, string> = { photo: "photos", video: "videos", audio: "files", document: "files" };

const VISIBILITY_OPTIONS = [
  { value: "private", label: "Solo yo" },
  { value: "published", label: "Visible para el artista" },
];

function compatibleFolders(item: UploadItem, folders: FolderOption[]) {
  const kind = FOLDER_KIND_FOR[UI_TO_CLASS[item.type]];
  return folders.filter((f) => f.artistId === item.artistId && (f.kind === "general" || f.kind === kind));
}

/** Tabla de clasificación: tipo, artista, categoría/carpeta y «Visible para» por archivo (y para todos a la vez). */
export function ClassifyTable({
  items,
  artists,
  folders,
  allowedTypes,
  publishableTypes,
  canUploadWithoutArtist,
  onChange,
  onApplyAll,
  onRemove,
}: ClassifyTableProps) {
  const typeOptions = (Object.keys(UI_TYPE_LABEL) as UiType[]).map((value) => ({
    value,
    label: UI_TYPE_LABEL[value] + (allowedTypes[value] ? "" : " (sin permiso)"),
  }));

  const artistOptions = (item: UploadItem) => [
    {
      value: "",
      label: item.type === "beat" && canUploadWithoutArtist ? "Sin artista (biblioteca)" : "Elige un artista…",
    },
    ...artists.map((a) => ({ value: a.id, label: a.name })),
  ];

  return (
    <div className="rounded-card border border-line bg-surface">
      {/* Aplicar a todos */}
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr]">
        <div>
          <Select
            label="Artista para todos"
            defaultValue=""
            options={[{ value: "", label: "Elige un artista…" }, ...artists.map((a) => ({ value: a.id, label: a.name }))]}
            onChange={(e) => e.target.value && onApplyAll({ artistId: e.target.value, folderId: null })}
          />
        </div>
        <div>
          <Select
            label="Visible para (todos)"
            defaultValue="private"
            options={VISIBILITY_OPTIONS}
            onChange={(e) => onApplyAll({ visibility: e.target.value as "private" | "published" })}
          />
        </div>
      </div>

      <ul className="divide-y divide-line">
        {items.map((item) => {
          const disabledType = !allowedTypes[item.type];
          const folderOptions = [
            { value: "", label: "Sin carpeta" },
            ...compatibleFolders(item, folders).map((f) => ({ value: f.id, label: f.name })),
          ];
          return (
            <li key={item.id} className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))_auto] lg:items-end">
              <div className="min-w-0">
                <p className="truncate text-body font-medium text-text" title={item.file.name}>
                  {item.file.name}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-text-2">
                  {formatBytes(item.file.size)}
                  {item.invalidReason ? <Badge variant="outline">{item.invalidReason}</Badge> : null}
                  {!item.invalidReason && item.type === "beat" ? (
                    <Badge variant="outline">Faltan datos del beat</Badge>
                  ) : null}
                  {!item.invalidReason && disabledType ? <Badge variant="outline">Sin permiso para este tipo</Badge> : null}
                </p>
              </div>

              <Select
                label="Tipo"
                value={item.type}
                options={typeOptions}
                disabled={!!item.invalidReason}
                onChange={(e) => onChange(item.id, { type: e.target.value as UiType, folderId: null })}
              />
              <Select
                label="Artista"
                value={item.artistId ?? ""}
                options={artistOptions(item)}
                disabled={!!item.invalidReason}
                onChange={(e) => onChange(item.id, { artistId: e.target.value || null, folderId: null })}
              />
              <Select
                label="Categoría / carpeta"
                value={item.folderId ?? ""}
                options={folderOptions}
                disabled={!!item.invalidReason || !item.artistId}
                onChange={(e) => onChange(item.id, { folderId: e.target.value || null })}
              />
              <Select
                label="Visible para"
                value={publishableTypes[item.type] ? item.visibility : "private"}
                options={
                  publishableTypes[item.type]
                    ? VISIBILITY_OPTIONS
                    : [{ value: "private", label: "Solo yo (sin permiso de publicar)" }]
                }
                disabled={!!item.invalidReason || !publishableTypes[item.type]}
                onChange={(e) => onChange(item.id, { visibility: e.target.value as "private" | "published" })}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Quitar ${item.file.name}`}
                onClick={() => onRemove(item.id)}
                className="justify-self-end"
              >
                <span aria-hidden="true" className="text-heading leading-none">
                  ×
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
