import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Códigos de recuperación de la verificación en dos pasos. Puro (sin Next): se prueba con `node --test`.
 * Se muestran UNA vez; en la base de datos solo queda SHA-256(sal + código normalizado) con una sal por código.
 */

export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O/1/I

/** «ab12cd34», «AB12-CD34» o «ab12 cd34» → «AB12CD34» */
export function normalizeRecoveryCode(input: string): string {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function generateRecoveryCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function hashRecoveryCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${normalizeRecoveryCode(code)}`).digest("hex");
}

export function newRecoverySet(count = RECOVERY_CODE_COUNT): { codes: string[]; rows: { salt: string; code_hash: string }[] } {
  const codes = Array.from({ length: count }, generateRecoveryCode);
  const rows = codes.map((code) => {
    const salt = randomBytes(16).toString("hex");
    return { salt, code_hash: hashRecoveryCode(code, salt) };
  });
  return { codes, rows };
}

export function matchesRecoveryCode(input: string, row: { salt: string; code_hash: string }): boolean {
  const a = Buffer.from(hashRecoveryCode(input, row.salt), "hex");
  const b = Buffer.from(row.code_hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
