import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDerivativeKey, buildOriginalKey, MAX_FILENAME_LENGTH, sanitizeFilename } from "./keys.ts";

const ARTIST = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";

test("saneado: nombres normales", () => {
  assert.equal(sanitizeFilename("foto.jpg"), "foto.jpg");
  assert.equal(sanitizeFilename("Mi Foto (1).JPG"), "Mi-Foto-1.jpg");
  assert.equal(sanitizeFilename("sesión_café.PNG"), "sesion_cafe.png");
});

test("saneado: recorridos de ruta (../) y separadores", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("..\\..\\windows\\system32\\evil.jpg"), "evil.jpg");
  assert.equal(sanitizeFilename("/absolute/path/file.mp4"), "file.mp4");
  assert.equal(sanitizeFilename("a/../b.jpg"), "b.jpg");
  assert.equal(sanitizeFilename(".."), "file");
  assert.equal(sanitizeFilename("..."), "file");
  assert.equal(sanitizeFilename("foo..jpg"), "foo.jpg");
});

test("saneado: espacios, emojis y caracteres raros", () => {
  assert.equal(sanitizeFilename("  espacios   varios  .jpg"), "espacios-varios.jpg");
  assert.equal(sanitizeFilename("🔥fuego🔥.png"), "fuego.png");
  assert.equal(sanitizeFilename("a<b>c|d\"e?.jpg"), "a-b-c-d-e.jpg");
  assert.equal(sanitizeFilename("nombre\u0000nulo.jpg"), "nombre-nulo.jpg");
  assert.equal(sanitizeFilename("日本語.jpg"), "file.jpg"); // solo ASCII: la base queda vacía pero se conserva la extensión
});

test("saneado: nunca vacío ni oculto", () => {
  assert.equal(sanitizeFilename(""), "file");
  assert.equal(sanitizeFilename("   "), "file");
  assert.equal(sanitizeFilename(".hidden"), "hidden");
  assert.equal(sanitizeFilename("🔥🔥🔥"), "file");
});

test("saneado: nombres largos conservan la extensión", () => {
  const long = "a".repeat(500) + ".jpg";
  const out = sanitizeFilename(long);
  assert.ok(out.length <= MAX_FILENAME_LENGTH);
  assert.ok(out.endsWith(".jpg"));
  const noExt = sanitizeFilename("b".repeat(500));
  assert.ok(noExt.length <= MAX_FILENAME_LENGTH);
});

test("saneado: solo caracteres seguros", () => {
  for (const input of ["x/y\\z.jpg", "a b\tc\nd.png", "%2e%2e%2f", "foo;rm -rf.sh", "…;¿?.jpg"]) {
    assert.match(sanitizeFilename(input), /^[A-Za-z0-9._-]+$/);
  }
});

test("claves: formato y sin escapes", () => {
  assert.equal(
    buildOriginalKey(ARTIST, ASSET, "Foto Final.JPG"),
    `artists/${ARTIST}/${ASSET}/original/Foto-Final.jpg`,
  );
  assert.equal(buildOriginalKey(null, ASSET, "beat.wav"), `shared/${ASSET}/original/beat.wav`);
  assert.equal(buildDerivativeKey(ARTIST, ASSET, "thumb"), `artists/${ARTIST}/${ASSET}/thumb/thumb.webp`);
  assert.equal(buildDerivativeKey(ARTIST, ASSET, "web"), `artists/${ARTIST}/${ASSET}/web/web.webp`);
  const hostile = buildOriginalKey(ARTIST, ASSET, "../../../otro-artista/x.jpg");
  assert.ok(!hostile.includes(".."));
  assert.ok(hostile.startsWith(`artists/${ARTIST}/${ASSET}/original/`));
  assert.equal(hostile.split("/").length, 5);
});

test("claves: ids que no son UUID se rechazan", () => {
  assert.throws(() => buildOriginalKey("../x", ASSET, "a.jpg"));
  assert.throws(() => buildOriginalKey(ARTIST, "no-uuid", "a.jpg"));
});
