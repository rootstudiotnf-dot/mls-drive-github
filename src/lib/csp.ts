/**
 * Content-Security-Policy con nonce por petición (la genera el proxy). Módulo puro: sin dependencias, con tests.
 *
 *  - Scripts: solo los de la propia web y los que lleven el nonce (`strict-dynamic` deja cargar los trozos que esos
 *    scripts piden). SIN `unsafe-inline` ni `unsafe-eval` en producción.
 *  - Estilos: `unsafe-inline` solo en `style-src` (React pinta atributos `style` —rejillas justificadas, barras de
 *    progreso— y los atributos no admiten nonce); los scripts, que es lo que importa, quedan estrictos.
 *  - Conexiones, imágenes y medios: la propia web y los orígenes de R2 (subidas y descargas directas con URL
 *    prefirmada). El navegador NO habla con Supabase: la sesión es HttpOnly y todo pasa por el servidor.
 */
export type CspInput = {
  nonce: string;
  /** Desarrollo: Next necesita `unsafe-eval` y websockets para el refresco en caliente. */
  dev?: boolean;
  /** Orígenes (esquema + host + puerto) de los buckets, p. ej. `https://<cuenta>.r2.cloudflarestorage.com`. */
  storageOrigins?: string[];
};

/** Solo orígenes http(s) bien formados; cualquier otra cosa se descarta (nunca se concatena texto libre en la política). */
export function cleanOrigins(values: (string | undefined | null)[]): string[] {
  const out = new Set<string>();
  for (const raw of values) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" || url.protocol === "http:") out.add(url.origin);
    } catch {
      // origen inválido: se ignora
    }
  }
  return [...out];
}

export function buildCsp({ nonce, dev = false, storageOrigins = [] }: CspInput): string {
  const storage = cleanOrigins(storageOrigins);
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", ...storage],
    "media-src": ["'self'", "blob:", ...storage],
    "font-src": ["'self'"],
    "connect-src": ["'self'", ...storage, ...(dev ? ["ws:", "wss:"] : [])],
    "worker-src": ["'self'", "blob:"],
    "frame-src": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "manifest-src": ["'self'"],
  };
  const parts = Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`);
  if (!dev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

/** Nonce de 128 bits en base64 (Web Crypto: vale en el proxy y en las pruebas). */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
