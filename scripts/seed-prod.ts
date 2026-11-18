/**
 * Datos de arranque de PRODUCCIÓN (sin datos de prueba). Se puede repetir sin riesgo: solo crea lo que falte.
 *
 *   npm run seed-prod -- --check     (solo comprueba y avisa; no escribe nada)
 *   npm run seed-prod                (comprueba y crea lo que falte)
 *
 * Qué garantiza:
 *  1. Las migraciones están aplicadas (existen las tablas clave) — si no, se detiene con un aviso claro.
 *  2. Los 5 roles de sistema y el catálogo de permisos (los siembran las migraciones; aquí solo se verifican).
 *  3. Las 6 carpetas base del Vault (las siembra la migración 0008; se recrean si faltan).
 *  4. Los ajustes por defecto de los beats (`app_settings`).
 *  5. Informa de si ya hay un owner activo (si no: `npm run create-owner`).
 * NO crea artistas, sesiones, archivos ni usuarios de prueba (para eso existe seed-demo, que se niega a correr en producción).
 * Usa el service role: ejecútalo solo en tu máquina o en la tarea de despliegue.
 */
import { createClient } from "@supabase/supabase-js";

const need = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Falta ${name}. Defínela en .env.local.`);
    process.exit(1);
  }
  return value;
};
const check = process.argv.includes("--check");
const db = createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });

const REQUIRED_TABLES = ["profiles", "roles", "permissions", "role_permissions", "artists", "sessions", "folders", "assets", "grants", "activity_log", "beats", "comments", "share_links", "notifications", "backup_runs"];
const SYSTEM_ROLES = ["owner", "admin", "artist", "photographer", "collaborator"];
const VAULT_FOLDERS = ["Vídeos originales", "BTS", "Tomas descartadas", "Fotos RAW", "Archivos de proyecto", "Documentos"];
const BEAT_DEFAULTS: Record<string, unknown> = { beat_voice_tag_interval_s: 25, beat_voice_tag_default: false };

let problems = 0;
const say = (ok: boolean, text: string) => {
  if (!ok) problems++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${text}`);
};

// 1. Migraciones
for (const table of REQUIRED_TABLES) {
  const { error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) {
    say(false, `Falta la tabla «${table}»: aplica las migraciones de supabase/migrations/ en orden (ver docs/DESPLIEGUE.md).`);
    process.exit(1);
  }
}
say(true, `Migraciones aplicadas (${REQUIRED_TABLES.length} tablas clave presentes)`);

// 2. Roles y permisos
const { data: roles } = await db.from("roles").select("key, is_locked");
const have = new Set(((roles ?? []) as { key: string }[]).map((r) => r.key));
for (const key of SYSTEM_ROLES) say(have.has(key), `Rol de sistema «${key}»`);
say(((roles ?? []) as { key: string; is_locked: boolean }[]).some((r) => r.key === "owner" && r.is_locked), "El rol owner está bloqueado (único e inmutable)");
const { count: perms } = await db.from("permissions").select("*", { count: "exact", head: true });
say((perms ?? 0) >= 30, `Catálogo de permisos (${perms ?? 0})`);

// 3. Carpetas base del Vault
const { data: folders } = await db.from("folders").select("name").eq("space", "vault").is("parent_id", null).is("deleted_at", null);
const haveFolders = new Set(((folders ?? []) as { name: string }[]).map((f) => f.name));
const missing = VAULT_FOLDERS.filter((n) => !haveFolders.has(n));
if (missing.length === 0) say(true, "Carpetas base del Vault");
else if (check) say(false, `Faltan carpetas del Vault: ${missing.join(", ")} (ejecuta sin --check para crearlas)`);
else {
  const { error } = await db.from("folders").insert(missing.map((name, i) => ({ name, kind: "general", space: "vault", sort: VAULT_FOLDERS.indexOf(name) ?? i })));
  say(!error, error ? "No se pudieron crear las carpetas del Vault" : `Carpetas del Vault creadas: ${missing.join(", ")}`);
}

// 4. Ajustes por defecto de beats
const { data: settings } = await db.from("app_settings").select("key");
const haveSettings = new Set(((settings ?? []) as { key: string }[]).map((s) => s.key));
const absent = Object.keys(BEAT_DEFAULTS).filter((k) => !haveSettings.has(k));
if (absent.length === 0) say(true, "Ajustes por defecto de beats");
else if (check) say(false, `Faltan ajustes: ${absent.join(", ")}`);
else {
  const { error } = await db.from("app_settings").upsert(absent.map((key) => ({ key, value: BEAT_DEFAULTS[key] })), { onConflict: "key", ignoreDuplicates: true });
  say(!error, error ? "No se pudieron crear los ajustes" : `Ajustes creados: ${absent.join(", ")}`);
}

// 5. Owner
const { data: ownerRole } = await db.from("roles").select("id").eq("key", "owner").maybeSingle();
const { count: owners } = ownerRole ? await db.from("profiles").select("*", { count: "exact", head: true }).eq("role_id", (ownerRole as { id: string }).id).eq("status", "active") : { count: 0 };
console.log(`  ${(owners ?? 0) > 0 ? "✓" : "•"} ${(owners ?? 0) > 0 ? `Owner activo: ${owners}` : "Todavía no hay owner: ejecuta `npm run create-owner`"}`);

console.log(problems === 0 ? "\nListo: la base de datos está preparada para producción." : `\n${problems} cosa(s) por corregir.`);
process.exit(problems === 0 ? 0 : 1);
