/** Tipos del estado de procesado de vídeo (seguros para el cliente: `jobs.ts` es solo de servidor). */
export type VideoJobStatus = "queued" | "processing" | "ready" | "failed";
export type VideoState = { status: VideoJobStatus | "none"; error: string | null };
