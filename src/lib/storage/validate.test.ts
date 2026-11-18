import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFilename, extensionOf, validateUpload } from "./validate.ts";

const MAX = 10 * 1024 ** 3;
const ok = (filename: string, size = 1000) => validateUpload({ filename, size, maxBytes: MAX });

test("extensiones permitidas por tipo", () => {
  for (const f of ["a.jpg", "a.JPEG", "a.png", "a.webp", "a.heic", "a.heif", "a.cr2", "a.cr3", "a.arw", "a.nef", "a.dng", "a.raf"]) {
    assert.equal(classifyFilename(f)?.cls, "photo", f);
  }
  for (const f of ["a.mp4", "a.mov", "a.m4v", "a.webm", "a.mxf"]) assert.equal(classifyFilename(f)?.cls, "video", f);
  for (const f of ["a.wav", "a.mp3", "a.flac", "a.aif", "a.aiff", "a.m4a"]) assert.equal(classifyFilename(f)?.cls, "audio", f);
  for (const f of ["a.pdf", "a.docx", "a.txt", "a.zip", "a.xlsx", "a.pptx"]) assert.equal(classifyFilename(f)?.cls, "document", f);
});

test("rechaza ejecutables, scripts y contenido activo", () => {
  for (const f of ["a.exe", "a.sh", "a.js", "a.html", "a.htm", "a.svg", "a.php", "a.bat", "a.ps1", "a.jar", "a.xml", "a.dll"]) {
    const r = ok(f);
    assert.equal(r.ok, false, f);
  }
});

test("rechaza lo que no está en la lista cerrada", () => {
  for (const f of ["a.gif", "a.bmp", "a.tiff", "a.avi", "a.rar", "a.7z", "a.doc", "a.csv", "a.psd", "a.unknown", "a.exe.txt.bak"]) {
    assert.equal(ok(f).ok, false, f);
  }
});

test("doble extensión: solo cuenta la última", () => {
  assert.equal(ok("foto.jpg.exe").ok, false);
  assert.equal(ok("foto.html.jpg").ok, true); // se sirve como imagen/jpeg y nunca se interpreta
  assert.equal(extensionOf("archivo.TAR.GZ"), "gz");
});

test("sin extensión o con punto final", () => {
  assert.equal(ok("README").ok, false);
  assert.equal(ok("foto.").ok, false);
  assert.equal(ok(".jpg").ok, false); // «.jpg» es un nombre oculto sin extensión
});

test("no se hereda de Object.prototype", () => {
  for (const f of ["a.constructor", "a.__proto__", "a.toString", "a.hasOwnProperty"]) {
    assert.equal(classifyFilename(f), null, f);
  }
});

test("el MIME sale de la tabla, no del cliente", () => {
  const r = ok("clip.MOV");
  assert.equal(r.ok && r.mime, "video/quicktime");
  const t = ok("notas.txt");
  assert.equal(t.ok && t.mime, "text/plain; charset=utf-8");
});

test("tamaños", () => {
  assert.equal(ok("a.jpg", 0).ok, false);
  assert.equal(ok("a.jpg", -5).ok, false);
  assert.equal(ok("a.jpg", 1.5).ok, false);
  assert.equal(ok("a.jpg", Number.NaN).ok, false);
  assert.equal(ok("a.jpg", MAX).ok, true);
  assert.equal(ok("a.jpg", MAX + 1).ok, false);
});

test("firma real: el contenido debe coincidir con la extensión", async () => {
  const { signatureMatches } = await import("./validate.ts");
  const b = (...v: number[]) => new Uint8Array(v);
  const text = (s: string, pad = 0) => new Uint8Array([...Array(pad).fill(0), ...[...s].map((c) => c.charCodeAt(0))]);
  assert.equal(signatureMatches("jpg", b(0xff, 0xd8, 0xff, 0xe0)), true);
  assert.equal(signatureMatches("jpg", text("MZ\u0090\u0000")), false); // un .exe renombrado a .jpg
  assert.equal(signatureMatches("png", b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), true);
  assert.equal(signatureMatches("pdf", text("%PDF-1.7")), true);
  assert.equal(signatureMatches("pdf", text("<html>")), false);
  assert.equal(signatureMatches("zip", b(0x50, 0x4b, 0x03, 0x04)), true);
  assert.equal(signatureMatches("docx", text("<?xml")), false);
  assert.equal(signatureMatches("mp4", text("ftypisom", 4)), true);
  assert.equal(signatureMatches("mp4", text("hello world, not a video")), false);
  assert.equal(signatureMatches("wav", text("RIFF\u0000\u0000\u0000\u0000WAVEfmt ")), true);
  assert.equal(signatureMatches("webp", text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")), true);
  assert.equal(signatureMatches("flac", text("fLaC")), true);
  assert.equal(signatureMatches("cr2", text("lo que sea")), true); // sin comprobación fiable: no se bloquea
  assert.equal(signatureMatches("jpg", new Uint8Array()), false);
});
