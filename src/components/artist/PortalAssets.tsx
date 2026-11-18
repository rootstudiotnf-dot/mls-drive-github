import { listArtistAssets, type AssetTab } from "@/app/actions/browse";
import { AssetBrowser } from "./AssetBrowser";

/** Listado del portal: solo lo publicado o lo que subió la propia persona; descarga si el archivo lo permite. */
export async function PortalAssets({
  artistId,
  tab,
  title,
  emptyTitle,
  emptyHint,
  footnote,
  videoBasePath,
}: {
  artistId: string;
  tab: AssetTab;
  title: string;
  emptyTitle: string;
  emptyHint?: string;
  footnote?: string;
  videoBasePath?: string;
}) {
  const first = await listArtistAssets({ artistId, tab, portal: true });
  const initial = first.ok && first.data ? first.data : { items: [], nextCursor: null };
  return (
    <AssetBrowser
      mode="portal"
      artistId={artistId}
      tab={tab}
      folderId={null}
      initial={initial}
      folders={[]}
      can={{ publish: false, edit: false }}
      title={title}
      emptyTitle={emptyTitle}
      emptyHint={emptyHint}
      footnote={footnote}
      videoBasePath={videoBasePath}
    />
  );
}
