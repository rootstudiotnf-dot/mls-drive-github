import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutRows, ratioOf, visibleRowRange } from "../components/gallery/layout.ts";
import { variantAllowed } from "./assets/variants.ts";
import { sortPhotos, type SessionPhoto } from "./sessions/types.ts";

const photo = (id: string, extra: Partial<SessionPhoto> = {}): SessionPhoto => ({
  id,
  title: id,
  filename: `${id}.jpg`,
  folderId: null,
  visibility: "published",
  downloadable: true,
  width: 3000,
  height: 2000,
  avgColor: null,
  sizeBytes: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  sortIndex: null,
  ...extra,
});

test("galería: cada fila ocupa todo el ancho, las alturas son enteras y se conocen antes de cargar", () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, ratio: [1.5, 0.8, 1.78, 1, 0.67][i % 5] as number }));
  const { rows, height } = layoutRows(items, 1000, 220, 8);
  assert.ok(rows.length > 5);
  for (const row of rows.slice(0, -1)) {
    const total = row.items.reduce((n, i) => n + i.width, 0) + 8 * (row.items.length - 1);
    assert.equal(total, 1000);
    assert.ok(Number.isInteger(row.height));
  }
  const last = rows.at(-1)!;
  assert.ok(last.height <= 220);
  assert.equal(height, last.top + last.height);
  assert.equal(rows.reduce((n, r) => n + r.items.length, 0), 120);
  // las filas no se solapan
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i]!.top, rows[i - 1]!.top + rows[i - 1]!.height + 8);
});

test("galería: sin dimensiones se asume 3:2 y se limitan los extremos", () => {
  assert.equal(ratioOf(null, null), 1.5);
  assert.equal(ratioOf(100, 0), 1.5);
  assert.equal(ratioOf(10_000, 100), 4);
  assert.equal(ratioOf(100, 10_000), 0.25);
  assert.equal(ratioOf(3000, 2000), 1.5);
});

test("galería: la ventana visible devuelve solo las filas cercanas (virtualización)", () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, ratio: 1.5 }));
  const { rows } = layoutRows(items, 1200, 200, 8);
  const range = visibleRowRange(rows, 5000, 6200);
  assert.ok(range.first > 0 && range.last >= range.first);
  assert.ok(range.last - range.first < 12, "se pintan pocas filas");
  const row = rows[range.first]!;
  assert.ok(row.top + row.height >= 5000);
  assert.ok((rows[range.last]!).top <= 6200);
  assert.deepEqual(visibleRowRange([], 0, 100), { first: 0, last: -1 });
});

test("ordenar: manual (con y sin sort_index), nombre natural y fecha", () => {
  const photos = [
    photo("b", { filename: "IMG_10.jpg", createdAt: "2026-01-03T00:00:00.000Z", sortIndex: 1 }),
    photo("a", { filename: "IMG_2.jpg", createdAt: "2026-01-02T00:00:00.000Z", sortIndex: 0 }),
    photo("c", { filename: "IMG_1.jpg", createdAt: "2026-01-01T00:00:00.000Z", sortIndex: null }),
    photo("d", { filename: "IMG_3.jpg", createdAt: "2026-01-04T00:00:00.000Z", sortIndex: null }),
  ];
  assert.deepEqual(sortPhotos(photos, "manual").map((p) => p.id), ["a", "b", "c", "d"]);
  assert.deepEqual(sortPhotos(photos, "name").map((p) => p.filename), ["IMG_1.jpg", "IMG_2.jpg", "IMG_3.jpg", "IMG_10.jpg"]);
  assert.deepEqual(sortPhotos(photos, "date").map((p) => p.id), ["d", "b", "a", "c"]);
});

test("modos de descarga: off no permite nada, web solo la versión web, original las dos", () => {
  assert.equal(variantAllowed("off", "original"), false);
  assert.equal(variantAllowed("off", "web"), false);
  assert.equal(variantAllowed("web", "web"), true);
  assert.equal(variantAllowed("web", "original"), false);
  assert.equal(variantAllowed("original", "original"), true);
  assert.equal(variantAllowed("original", "web"), true);
  assert.equal(variantAllowed("original", "thumb"), false);
  assert.equal(variantAllowed("web", "proxy"), false);
});

import { buildThreads, formatTimecode, parseTimecode, type CommentItem } from "./comments/types.ts";

const c = (id: string, extra: Partial<CommentItem> = {}): CommentItem => ({
  id, parentId: null, authorName: "A", mine: false, body: id, timecodeMs: null, resolved: false, createdAt: "2026-01-01T00:00:00.000Z", editedAt: null, external: false, mentions: [], ...extra,
});

test("comentarios: formato y lectura de marcas de tiempo", () => {
  assert.equal(formatTimecode(0), "0:00");
  assert.equal(formatTimecode(65_400), "1:05");
  assert.equal(formatTimecode(3_723_000), "1:02:03");
  assert.equal(parseTimecode("1:05"), 65_000);
  assert.equal(parseTimecode("90"), 90_000);
  assert.equal(parseTimecode("1:02:03"), 3_723_000);
  assert.equal(parseTimecode("abc"), null);
  assert.equal(parseTimecode("1:2:3:4"), null);
  assert.equal(parseTimecode(""), null);
});

test("comentarios: hilos ordenados por marca de tiempo, generales al final, respuestas por fecha", () => {
  const threads = buildThreads([
    c("general", { timecodeMs: null }),
    c("tarde", { timecodeMs: 60_000 }),
    c("pronto", { timecodeMs: 5_000 }),
    c("r2", { parentId: "pronto", createdAt: "2026-01-02T00:00:00.000Z" }),
    c("r1", { parentId: "pronto", createdAt: "2026-01-01T12:00:00.000Z" }),
  ]);
  assert.deepEqual(threads.map((t) => t.id), ["pronto", "tarde", "general"]);
  assert.deepEqual(threads[0]!.replies.map((r) => r.id), ["r1", "r2"]);
});
