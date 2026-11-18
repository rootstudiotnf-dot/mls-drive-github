import "server-only";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { getShareSalt } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Límite de intentos de inicio de sesión y de enlaces mágicos (además del que ya aplica Supabase Auth).
 * Se cuenta por IP y por correo con la función SQL `rate_hit` (ventanas fijas). Nada se guarda en claro:
 * ni la IP ni el correo, solo un hash con sal. Si no se puede contar, se deniega (falla cerrado).
 */
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_PER_IP = 30;
export const LOGIN_PER_EMAIL = 8;
export const MAGIC_PER_IP = 10;
export const MAGIC_PER_EMAIL = 3;

const digest = (value: string, salt: string) => createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 32);

async function ipKey(): Promise<string> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "desconocida").trim();
  return digest(ip, getShareSalt() ?? "mls-login");
}

async function hit(key: string, limit: number): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("rate_hit", { p_key: key, p_window_seconds: LOGIN_WINDOW_SECONDS, p_limit: limit });
  return !error && data === true;
}

/** true = se permite el intento. */
export async function allowLogin(email: string): Promise<boolean> {
  const salt = getShareSalt() ?? "mls-login";
  const [byIp, byEmail] = await Promise.all([hit(`login:ip:${await ipKey()}`, LOGIN_PER_IP), hit(`login:em:${digest(email.toLowerCase(), salt)}`, LOGIN_PER_EMAIL)]);
  return byIp && byEmail;
}

export async function allowMagicLink(email: string): Promise<boolean> {
  const salt = getShareSalt() ?? "mls-login";
  const [byIp, byEmail] = await Promise.all([hit(`magic:ip:${await ipKey()}`, MAGIC_PER_IP), hit(`magic:em:${digest(email.toLowerCase(), salt)}`, MAGIC_PER_EMAIL)]);
  return byIp && byEmail;
}
