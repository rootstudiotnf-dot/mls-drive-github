import assert from "node:assert/strict";
import { test } from "node:test";
import { MUSICAL_KEYS, normalizeKey, publishProblems, suggestFromFilename } from "./types.ts";

test("tonalidades: normalización de Am, a minor, F#m, Bbmin, Cmaj…", () => {
  assert.equal(normalizeKey("Am"), "Am");
  assert.equal(normalizeKey("a"), "A");
  assert.equal(normalizeKey("F#m"), "F#m");
  assert.equal(normalizeKey("Bbmin"), "A#m");
  assert.equal(normalizeKey("Cmaj"), "C");
  assert.equal(normalizeKey("Ebminor"), "D#m");
  assert.equal(normalizeKey("H"), null);
  assert.equal(normalizeKey("xyz"), null);
  assert.ok(MUSICAL_KEYS.includes("C#m") && MUSICAL_KEYS.includes("G") && MUSICAL_KEYS.length === 24);
  for (const k of MUSICAL_KEYS) assert.equal(normalizeKey(k), k);
});

test("sugerencias por nombre de archivo", () => {
  assert.deepEqual(suggestFromFilename("Nombre_140_Am.wav"), { title: "Nombre", bpm: 140, key: "Am" });
  assert.deepEqual(suggestFromFilename("Mi Beat Oscuro - 92 BPM - F#m.mp3"), { title: "Mi Beat Oscuro", bpm: 92, key: "F#m" });
  assert.deepEqual(suggestFromFilename("lluvia_Cm_85.flac"), { title: "lluvia", bpm: 85, key: "Cm" });
  assert.deepEqual(suggestFromFilename("beat 150bpm D minor.wav"), { title: "beat", bpm: 150, key: "Dm" });
  assert.deepEqual(suggestFromFilename("Sin datos.wav"), { title: "Sin datos", bpm: null, key: null });
  assert.deepEqual(suggestFromFilename("A.wav"), { title: "A", bpm: null, key: null });
  assert.deepEqual(suggestFromFilename("Trap_2024_final.wav"), { title: "Trap 2024 final", bpm: null, key: null }, "un año no es un BPM");
  assert.deepEqual(suggestFromFilename("C:\\carpeta\\Noche_128_Bb.m4a"), { title: "Noche", bpm: 128, key: "A#" });
});

test("publicar: qué falta", () => {
  assert.deepEqual(publishProblems({ title: "x", bpm: 100, key: "Am", genreId: "g", previewReady: true }), []);
  assert.deepEqual(publishProblems({ title: " ", bpm: null, key: null, genreId: null, previewReady: false }), ["el título", "el BPM", "la tonalidad", "el género", "el preview (aún se está procesando)"]);
});
