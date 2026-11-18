export const MAX_SKEW_MS: number;
export function sign(secret: string, timestamp: string, nonce: string, body: string): string;
export function signedHeaders(secret: string, body: string, now?: number): Record<string, string>;
export function safeEqualHex(a: string, b: string): boolean;
export function verify(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  body: string,
  now?: number,
): { ok: true; nonce: string } | { ok: false; reason: string };
export class NonceStore {
  constructor(ttlMs?: number);
  use(nonce: string, now?: number): boolean;
}
