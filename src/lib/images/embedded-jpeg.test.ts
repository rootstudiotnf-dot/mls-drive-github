import assert from "node:assert/strict";
import { test } from "node:test";
import { findEmbeddedJpegs, type Reader } from "./embedded-jpeg.ts";
import { averageColor } from "./color.ts";

/** JPEG sintético: estructura válida (SOI, APP, DQT, SOF0, DHT, SOS, datos con FF00 y RST, EOI). No se decodifica. */
function fakeJpeg(payload: number, app?: Uint8Array): Uint8Array {
  const parts: number[][] = [
    [0xff, 0xd8],
    [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
  ];
  if (app) parts.push([0xff, 0xe1, (app.length + 2) >> 8, (app.length + 2) & 255, ...app]);
  parts.push([0xff, 0xdb, 0x00, 0x05, 0, 1, 2]); // DQT
  parts.push([0xff, 0xc0, 0x00, 0x0b, 8, 0, 8, 0, 8, 1, 1, 0x11, 0]); // SOF0
  parts.push([0xff, 0xc4, 0x00, 0x04, 0, 1]); // DHT
  parts.push([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]); // SOS
  const entropy: number[] = [];
  for (let i = 0; i < payload; i++) {
    const v = (i * 37 + 11) & 255;
    if (v === 0xff) entropy.push(0xff, 0x00); // byte stuffing
    else entropy.push(v);
    if (i % 997 === 0) entropy.push(0xff, 0xd0 + ((i / 997) % 8)); // RSTn dentro de los datos
  }
  parts.push(entropy);
  parts.push([0xff, 0xd9]);
  return Uint8Array.from(parts.flat());
}

const readerOf = (buffer: Uint8Array): Reader => async (start, end) => buffer.subarray(start, Math.min(end, buffer.length));

function container(pieces: Uint8Array[], noise = 5000) {
  const junk = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + 5) & 0xef); // sin 0xFF
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  for (const piece of pieces) {
    const filler = junk(noise);
    chunks.push(filler);
    at += filler.length;
    offsets.push(at);
    chunks.push(piece);
    at += piece.length;
  }
  chunks.push(junk(noise));
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    all.set(c, p);
    p += c.length;
  }
  return { all, offsets };
}

test("jpeg incrustado: encuentra el mayor de varios y devuelve sus límites exactos", async () => {
  const small = fakeJpeg(4000);
  const large = fakeJpeg(60_000);
  const { all, offsets } = container([small, large]);
  const found = await findEmbeddedJpegs(readerOf(all), all.length);
  assert.equal(found.length, 2);
  assert.equal(found[0]?.start, offsets[1]);
  assert.equal(found[0]?.length, large.length);
  assert.equal(found[1]?.start, offsets[0]);
});

test("jpeg incrustado: un JPEG anidado dentro de un segmento APP1 no cuenta como independiente", async () => {
  const thumb = fakeJpeg(3000);
  const outer = fakeJpeg(30_000, thumb); // la miniatura viaja dentro del EXIF
  const { all, offsets } = container([outer]);
  const found = await findEmbeddedJpegs(readerOf(all), all.length);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.start, offsets[0]);
  assert.equal(found[0]?.length, outer.length);
});

test("jpeg incrustado: lee por trozos y encuentra uno que cruza el límite de 4 MiB", async () => {
  const large = fakeJpeg(200_000);
  const pad = 4 * 1024 * 1024 - 1000;
  const { all, offsets } = container([large], pad);
  let reads = 0;
  const reader: Reader = async (s, e) => {
    reads++;
    assert.ok(e - s <= 4 * 1024 * 1024 + 4, "no se pide más de un trozo a la vez");
    return all.subarray(s, Math.min(e, all.length));
  };
  const found = await findEmbeddedJpegs(reader, all.length);
  assert.equal(found[0]?.start, offsets[0]);
  assert.ok(reads > 2);
});

test("jpeg incrustado: sin JPEG válido devuelve una lista vacía y no falla", async () => {
  const noise = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 7) & 0xef);
  assert.deepEqual(await findEmbeddedJpegs(readerOf(noise), noise.length), []);
  const truncated = fakeJpeg(8000).subarray(0, 5000); // sin EOI
  const { all } = container([truncated]);
  assert.deepEqual(await findEmbeddedJpegs(readerOf(all), all.length), []);
});

test("color medio: promedia píxeles RGBA y devuelve #rrggbb", () => {
  const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]);
  assert.equal(averageColor(data), "#800080");
  assert.equal(averageColor(new Uint8ClampedArray([10, 20, 30, 255])), "#0a141e");
  assert.equal(averageColor(new Uint8ClampedArray(0)), null);
  // los píxeles transparentes no cuentan
  assert.equal(averageColor(new Uint8ClampedArray([200, 100, 50, 255, 0, 0, 0, 0])), "#c86432");
});
