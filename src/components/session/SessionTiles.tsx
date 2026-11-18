import { ImageIcon } from "@/components/icons";
import { PhotoTile } from "@/components/ui/PhotoTile";

export type SessionTileData = {
  id: string;
  name: string;
  href: string;
  /** «Artista · 24 fotos» */
  meta: string;
  coverUrl?: string;
};

/** Rejilla de sesiones: portada 4/5, nombre y datos. Sin JS de cliente (las miniaturas llegan ya firmadas). */
export function SessionTiles({ sessions }: { sessions: SessionTileData[] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-5 md:grid-cols-3 wide:grid-cols-4">
      {sessions.map((session) => (
        <li key={session.id} className="min-w-0">
          <PhotoTile
            href={session.href}
            tone={((session.id.charCodeAt(0) % 5) + 1) as 1 | 2 | 3 | 4 | 5}
            imageUrl={session.coverUrl}
            icon={<ImageIcon size={26} className="text-text-3" />}
            title={session.name}
            meta={session.meta}
          />
        </li>
      ))}
    </ul>
  );
}
