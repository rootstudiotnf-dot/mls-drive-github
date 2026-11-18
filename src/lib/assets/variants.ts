/** Tipos y reglas puras de variantes y modos de descarga (seguras para el cliente: sin acceso a datos). */

export type AssetVariant = "original" | "thumb" | "web" | "proxy" | "poster" | "audio_preview";
export type AssetUrlMode = "view" | "download";
export type DownloadMode = "off" | "web" | "original";

export const DOWNLOAD_MODE_LABEL: Record<DownloadMode, string> = {
  off: "Desactivada",
  web: "Versión web",
  original: "Original",
};

/**
 * ¿Permite este modo de descarga de la sesión esta variante?
 *   off → nada · web → solo la versión web · original → la original y también la web.
 */
export function variantAllowed(mode: DownloadMode, variant: AssetVariant): boolean {
  if (mode === "original") return variant === "original" || variant === "web";
  if (mode === "web") return variant === "web";
  return false;
}
