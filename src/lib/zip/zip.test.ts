import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, inspectZip, planZipParts, safeZipName, uniqueNames, ZipWriter, ZIP_MAX_FILES } from "./zip.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

test("crc32: valores conocidos y cálculo incremental", () => {
  assert.equal(crc32(bytes("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  const whole = crc32(bytes("hola mundo, esto es una prueba"));
  const parts = crc32(bytes(" esto es una prueba"), crc32(bytes("hola mundo,")));
  assert.equal(parts, whole);
});

test("nombres: saneado y duplicados", () => {
  assert.equal(safeZipName("../../etc/passwd"), "passwd");
  assert.equal(safeZipName("a:b*c?.jpg"), "a_b_c_.jpg");
  assert.equal(safeZipName(".."), "archivo");
  assert.deepEqual(uniqueNames(["a.jpg", "A.JPG", "a.jpg", "b"]), ["a.jpg", "A (2).JPG", "a (3).jpg", "b"]);
});

function build(files: { name: string; data: Uint8Array; chunks?: number }[]) {
  const zip = new ZipWriter();
  const out: Uint8Array[] = [];
  for (const file of files) {
    out.push(zip.begin(file.name, new Date(2026, 10, 17, 10, 30, 12)));
    const size = Math.ceil(file.data.length / (file.chunks ?? 1)) || 1;
    for (let at = 0; at < file.data.length; at += size) {
      const piece = file.data.subarray(at, at + size);
      zip.chunk(piece);
      out.push(piece);
    }
    out.push(zip.end());
  }
  out.push(zip.finish());
  const total = out.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const part of out) {
    all.set(part, at);
    at += part.length;
  }
  assert.equal(total, zip.bytesWritten);
  return all;
}

test("zip: estructura, nombres UTF-8, tamaños y CRC correctos", () => {
  const big = new Uint8Array(300_000).map((_, i) => (i * 31) & 255);
  const zip = build([
    { name: "foto-1.jpg", data: bytes("contenido uno") },
    { name: "sesión ñandú.webp", data: big, chunks: 7 },
    { name: "vacío.txt", data: new Uint8Array(0) },
  ]);
  const entries = inspectZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ["foto-1.jpg", "sesión ñandú.webp", "vacío.txt"]);
  assert.deepEqual(entries.map((e) => e.size), [13, 300_000, 0]);
  assert.ok(entries.every((e) => e.crcOk));
  assert.deepEqual([...(entries[1] as { data: Uint8Array }).data], [...big]);
  assert.equal(new TextDecoder().decode((entries[0] as { data: Uint8Array }).data), "contenido uno");
});

test("zip: cabecera con bit 3 y bit 11, método store y fin de directorio", () => {
  const zip = build([{ name: "a.txt", data: bytes("x") }]);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x0808);
  assert.equal(view.getUint16(8, true), 0);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(zip.length - 22 + 10, true), 1);
});

test("zip: se rechaza abrir dos archivos a la vez y pasar del máximo de entradas", () => {
  const zip = new ZipWriter();
  zip.begin("a");
  assert.throws(() => zip.begin("b"));
  zip.end();
  const full = new ZipWriter();
  for (let i = 0; i < ZIP_MAX_FILES; i++) {
    full.begin(`f${i}`);
    full.end();
  }
  assert.throws(() => full.begin("uno-mas"));
});

test("partes: divide por tamaño y por número de archivos", () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `f${i}.jpg`, size: 1_000_000_000 }));
  const parts = planZipParts(files, 3_500_000_000, 500);
  assert.deepEqual(parts.map((p) => p.length), [3, 3, 3, 1]);
  const many = Array.from({ length: 1200 }, (_, i) => ({ id: String(i), name: `f${i}`, size: 10 }));
  assert.deepEqual(planZipParts(many).map((p) => p.length), [500, 500, 200]);
  const huge = [{ id: "h", name: "h", size: 9_000_000_000 }, { id: "s", name: "s", size: 5 }];
  assert.deepEqual(planZipParts(huge).map((p) => p.length), [1, 1]);
});
