"use client";

import { useCallback, useEffect, useState } from "react";
import { listComments } from "@/app/actions/comments";
import { CommentsPanel } from "@/components/comments/CommentsPanel";
import type { CommentsData } from "@/lib/comments/types";

const EMPTY: CommentsData = { comments: [], canComment: false, canModerate: false };

/** Comentarios de una foto (sin marca de tiempo): el mismo panel que en vídeo y beats. */
export function PhotoComments({ assetId }: { assetId: string }) {
  const [data, setData] = useState<CommentsData>(EMPTY);

  const refresh = useCallback(async () => {
    const res = await listComments(assetId);
    if (res.ok && res.data) setData(res.data);
  }, [assetId]);

  useEffect(() => {
    let cancelled = false;
    void listComments(assetId).then((res) => {
      if (!cancelled) setData(res.ok && res.data ? res.data : EMPTY);
    });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  return <CommentsPanel assetId={assetId} data={data} activeId={null} timed={false} getTimeMs={() => 0} pause={() => undefined} seekMs={() => undefined} onChanged={() => void refresh()} />;
}
