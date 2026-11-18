/**
 * Datos de EJEMPLO para probar permisos (solo desarrollo).
 *
 *   npm run seed-demo -- --yes
 *
 * Crea 3 artistas con sesiones, carpetas y assets de ejemplo (solo metadatos: NO hay archivos en el
 * almacenamiento), 1 asset del Vault y 2 beats. Es idempotente: se puede ejecutar varias veces.
 *
 *   npm run seed-demo -- --yes --big[=500]
 *
 * Con --big añade además N assets (500 por defecto) a CADA artista de ejemplo, repartidos por sus carpetas
 * Fotos/Vídeos y con una mezcla de publicados y privados, para probar la paginación y los índices.
 *
 * AVISO: escribe en la base de datos de .env.local con el service role. Por eso:
 *  - se niega a ejecutarse si NODE_ENV=production;
 *  - se niega si NEXT_PUBLIC_SITE_URL no apunta a localhost / 127.0.0.1 (señal de que el entorno no es local);
 *  - exige la confirmación explícita --yes.
 * No lo ejecutes contra un proyecto de Supabase con datos reales.
 *
 * Requiere Node 22.18+ (ejecuta TypeScript directamente); solo usa sintaxis borrable.
 */
import { createClient } from "@supabase/supabase-js";

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

// --- Protecciones -------------------------------------------------------------------------------
if (process.env.NODE_ENV === "production") {
  stop("seed-demo está bloqueado en producción (NODE_ENV=production).");
}
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";
let siteHost = "";
try {
  siteHost = new URL(siteUrl).hostname;
} catch {
  stop("NEXT_PUBLIC_SITE_URL no es una URL válida. Defínela en .env.local (http://localhost:3000).");
}
if (siteHost !== "localhost" && siteHost !== "127.0.0.1" && siteHost !== "[::1]") {
  stop(
    `seed-demo está bloqueado: NEXT_PUBLIC_SITE_URL (${siteHost}) no es local.\n` +
      "Este script solo es para entornos de desarrollo.",
  );
}
console.warn(
  "⚠  seed-demo: va a escribir DATOS DE EJEMPLO en la base de datos configurada en .env.local.\n" +
    "   No lo uses con datos reales.",
);
if (!process.argv.includes("--yes")) {
  stop("Añade --yes para confirmar:  npm run seed-demo -- --yes");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) stop("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local.");

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

function must<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error || result.data === null) stop(`${what}: ${result.error?.message ?? "sin datos"}`);
  return result.data;
}

// --- Autor de los datos: el owner activo (si lo hay) ---------------------------------------------
const { data: ownerRole } = await db.from("roles").select("id").eq("key", "owner").maybeSingle();
if (!ownerRole) stop("No se encontró el rol owner. ¿Aplicaste las migraciones 0001 y 0002?");
const { data: owner } = await db
  .from("profiles")
  .select("id")
  .eq("role_id", ownerRole.id)
  .eq("status", "active")
  .limit(1)
  .maybeSingle();
const authorId: string | null = owner?.id ?? null;
if (!authorId) console.warn("   (No hay owner activo todavía: los datos se crean sin autor.)");

// --- Artistas -------------------------------------------------------------------------------------
const artistDefs = [
  { name: "Pepito", slug: "demo-pepito", bio: "Artista de ejemplo (trap)." },
  { name: "Marta Vidal", slug: "demo-marta-vidal", bio: "Artista de ejemplo (pop urbano)." },
  { name: "Nico Rey", slug: "demo-nico-rey", bio: "Artista de ejemplo (drill)." },
];

type Row = { id: string };
const artists: { id: string; name: string; slug: string }[] = [];
for (const def of artistDefs) {
  const { data: existing } = await db.from("artists").select("id").eq("slug", def.slug).maybeSingle();
  if (existing) {
    artists.push({ ...def, id: (existing as Row).id });
    continue;
  }
  const created = must(
    await db.from("artists").insert({ ...def, created_by: authorId }).select("id").single(),
    `crear artista ${def.name}`,
  ) as Row;
  artists.push({ ...def, id: created.id });
}

// --- Sesiones, carpetas y assets (solo metadatos) --------------------------------------------------
let assetCount = 0;
for (const artist of artists) {
  const folderName = "Material";
  let { data: folder } = await db
    .from("folders")
    .select("id")
    .eq("artist_id", artist.id)
    .eq("name", folderName)
    .maybeSingle();
  if (!folder) {
    folder = must(
      await db
        .from("folders")
        .insert({ artist_id: artist.id, name: folderName, kind: "general" })
        .select("id")
        .single(),
      "crear carpeta",
    ) as Row;
  }

  for (const n of [1, 2]) {
    const sessionName = `Sesión ${String(n).padStart(2, "0")}`;
    let { data: session } = await db
      .from("sessions")
      .select("id")
      .eq("artist_id", artist.id)
      .eq("name", sessionName)
      .maybeSingle();
    if (!session) {
      session = must(
        await db
          .from("sessions")
          .insert({
            artist_id: artist.id,
            name: sessionName,
            date: `2026-0${n + 2}-1${n}`,
            description: "Sesión de ejemplo.",
            created_by: authorId,
          })
          .select("id")
          .single(),
        "crear sesión",
      ) as Row;
    }

    // Por sesión: 2 fotos publicadas (una descargable), 1 privada, 1 vídeo y 1 documento
    const defs = [
      { kind: "photo", file: "01.jpg", visibility: "published", downloadable: true, mime: "image/jpeg", w: 4000, h: 5000 },
      { kind: "photo", file: "02.jpg", visibility: "published", downloadable: false, mime: "image/jpeg", w: 4000, h: 5000 },
      { kind: "photo", file: "03-privada.jpg", visibility: "private", downloadable: false, mime: "image/jpeg", w: 4000, h: 5000 },
      { kind: "video", file: "clip.mp4", visibility: "published", downloadable: true, mime: "video/mp4", w: 1920, h: 1080 },
      { kind: "document", file: "notas.pdf", visibility: "published", downloadable: true, mime: "application/pdf", w: null, h: null },
    ] as const;

    for (const d of defs) {
      const key = `demo/${artist.slug}/${sessionName.replace(" ", "-").toLowerCase()}/${d.file}`;
      const { data: found } = await db.from("assets").select("id").eq("storage_key", key).maybeSingle();
      if (found) continue;
      const { error } = await db.from("assets").insert({
        kind: d.kind,
        space: "workspace",
        artist_id: artist.id,
        session_id: (session as Row).id,
        folder_id: n === 1 ? (folder as Row).id : null,
        title: d.file,
        original_filename: d.file,
        storage_key: key,
        mime: d.mime,
        size_bytes: 1_000_000,
        width: d.w,
        height: d.h,
        status: "ready",
        visibility: d.visibility,
        downloadable: d.downloadable,
        uploaded_by: authorId,
      });
      if (error) stop(`crear asset ${key}: ${error.message}`);
      assetCount++;
    }
  }
}

// --- Vault (un documento de ejemplo) ----------------------------------------------------------------
{
  const key = "demo/vault/contrato-ejemplo.pdf";
  const { data: found } = await db.from("assets").select("id").eq("storage_key", key).maybeSingle();
  if (!found) {
    const { error } = await db.from("assets").insert({
      kind: "document",
      space: "vault",
      title: "Contrato de ejemplo",
      original_filename: "contrato-ejemplo.pdf",
      storage_key: key,
      mime: "application/pdf",
      size_bytes: 200_000,
      status: "ready",
      visibility: "published",
      downloadable: false,
      uploaded_by: authorId,
    });
    if (error) stop(`crear asset del Vault: ${error.message}`);
    assetCount++;
  }
}

// --- Beats ----------------------------------------------------------------------------------------------
let { data: genre } = await db.from("genres").select("id").eq("name", "Trap").maybeSingle();
if (!genre) genre = must(await db.from("genres").insert({ name: "Trap" }).select("id").single(), "crear género") as Row;

const beatDefs = [
  { title: "Beat 01 (demo)", file: "beat-01.wav", bpm: 142, key: "Fa menor", status: "published", downloadable: true },
  { title: "Beat 02 (demo)", file: "beat-02.wav", bpm: 96, key: "Do menor", status: "draft", downloadable: false },
] as const;
let beatCount = 0;
for (const b of beatDefs) {
  const { data: existing } = await db.from("beats").select("id").eq("title", b.title).maybeSingle();
  if (existing) continue;
  const key = `demo/beats/${b.file}`;
  let { data: audio } = await db.from("assets").select("id").eq("storage_key", key).maybeSingle();
  if (!audio) {
    audio = must(
      await db
        .from("assets")
        .insert({
          kind: "audio",
          space: "workspace",
          title: b.title,
          original_filename: b.file,
          storage_key: key,
          mime: "audio/wav",
          size_bytes: 30_000_000,
          duration_seconds: 182,
          status: "ready",
          visibility: "published",
          downloadable: b.downloadable,
          uploaded_by: authorId,
        })
        .select("id")
        .single(),
      "crear audio del beat",
    ) as Row;
  }
  const { error } = await db.from("beats").insert({
    asset_id: (audio as Row).id,
    title: b.title,
    bpm: b.bpm,
    musical_key: b.key,
    genre_id: (genre as Row).id,
    status: b.status,
    downloadable: b.downloadable,
    created_by: authorId,
  });
  if (error) stop(`crear beat ${b.title}: ${error.message}`);
  beatCount++;
}

// --- Volumen (--big): N assets por artista, solo metadatos, en lotes de 100 ----------------------------------
const bigArg = process.argv.find((a) => a === "--big" || a.startsWith("--big="));
let bulkCount = 0;
if (bigArg) {
  const requested = Number(bigArg.split("=")[1] ?? "500");
  const target = Number.isInteger(requested) && requested > 0 && requested <= 5000 ? requested : 500;
  for (const artist of artists) {
    const { data: roots } = await db
      .from("folders")
      .select("id, kind")
      .eq("artist_id", artist.id)
      .is("parent_id", null)
      .in("kind", ["photos", "videos"]);
    const folderOf = new Map(((roots ?? []) as { id: string; kind: string }[]).map((f) => [f.kind, f.id]));
    const { count } = await db
      .from("assets")
      .select("id", { count: "exact", head: true })
      .eq("artist_id", artist.id)
      .like("storage_key", `demo/${artist.slug}/bulk/%`);
    const missing = target - (count ?? 0);
    if (missing <= 0) continue;

    const start = count ?? 0;
    const base = Date.now() - target * 60_000;
    for (let from = 0; from < missing; from += 100) {
      const rows = [];
      for (let i = from; i < Math.min(from + 100, missing); i++) {
        const n = start + i;
        const isVideo = n % 5 === 0;
        const file = `${String(n).padStart(4, "0")}.${isVideo ? "mp4" : "jpg"}`;
        rows.push({
          kind: isVideo ? "video" : "photo",
          space: "workspace",
          artist_id: artist.id,
          folder_id: folderOf.get(isVideo ? "videos" : "photos") ?? null,
          title: `Material ${String(n).padStart(4, "0")}`,
          original_filename: file,
          storage_key: `demo/${artist.slug}/bulk/${file}`,
          mime: isVideo ? "video/mp4" : "image/jpeg",
          size_bytes: 2_000_000,
          width: isVideo ? 1920 : 4000,
          height: isVideo ? 1080 : 5000,
          status: "ready",
          visibility: n % 3 === 0 ? "private" : "published",
          downloadable: n % 2 === 0,
          uploaded_by: authorId,
          created_at: new Date(base + n * 60_000).toISOString(),
        });
      }
      const { error } = await db.from("assets").insert(rows);
      if (error) stop(`crear lote de assets (${artist.slug}): ${error.message}`);
      bulkCount += rows.length;
    }
  }
}

console.log(`Listo: ${artists.length} artistas · ${assetCount} assets nuevos · ${beatCount} beats nuevos${bigArg ? ` · ${bulkCount} assets de volumen` : ""} (solo metadatos).`);
console.log("Asigna personas a los artistas en /accesos para probar los permisos.");
