import { abortMove, completeMove, signMoveStep, type MovePlan } from "@/app/actions/vault-move";
import { AbortedError, FatalError, putBlob, TransferError, withRetries } from "@/components/upload/transfer";

/**
 * Copia de un archivo entre el bucket normal y el del Vault, hecha por el NAVEGADOR parte a parte (los archivos
 * nunca pasan por el servidor). Cada parte pide al servidor URLs de 5 minutos (origen y destino), lee su tramo con
 * `Range` y lo escribe como una parte del destino. Al terminar, el servidor VERIFICA (tamaño y ETag) y solo entonces
 * cambia las filas y borra el original. Cualquier fallo → se descarta lo copiado y el archivo sigue donde estaba.
 */
export async function moveAsset(plan: MovePlan, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<{ ok: true } | { ok: false; message: string }> {
  const parts = plan.partSize ? plan.totalParts : 1;
  try {
    for (let n = 1; n <= parts; n++) {
      await withRetries(async () => {
        const step = await signMoveStep({ assetId: plan.assetId, partNumber: n });
        if (!step.ok || !step.data) throw new FatalError(step.ok ? "Respuesta vacía" : step.message);
        const start = plan.partSize ? (n - 1) * plan.partSize : 0;
        const end = plan.partSize ? Math.min(plan.size, start + plan.partSize) - 1 : plan.size - 1;
        const response = await fetch(step.data.sourceUrl, { headers: plan.partSize ? { Range: `bytes=${start}-${end}` } : undefined, signal });
        if (response.status !== 200 && response.status !== 206) throw new TransferError(`origen HTTP ${response.status}`, response.status, response.status >= 500 || response.status === 403);
        const blob = await response.blob();
        if (blob.size !== end - start + 1) throw new TransferError("tamaño de parte inesperado", 0, true);
        await putBlob({ url: step.data.destUrl, body: blob, headers: step.data.destHeaders, signal });
      }, signal);
      onProgress(n / parts);
    }
    const done = await completeMove({ assetId: plan.assetId });
    if (!done.ok) {
      await abortMove({ assetId: plan.assetId }).catch(() => undefined);
      return { ok: false, message: done.message };
    }
    return { ok: true };
  } catch (error) {
    await abortMove({ assetId: plan.assetId }).catch(() => undefined);
    if (error instanceof AbortedError || signal.aborted) return { ok: false, message: "Movimiento cancelado. El archivo sigue donde estaba." };
    return { ok: false, message: "Se interrumpió la copia. El archivo sigue donde estaba y no se ha cambiado nada." };
  }
}
