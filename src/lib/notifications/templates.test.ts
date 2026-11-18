import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, DEFAULTS, EVENTS, mergePayloads, safePayload } from "./events.ts";
import { groupForDigest, renderDigest, renderInstant, signUnsubscribe, verifyUnsubscribe } from "./templates.ts";

const USER = "00000000-0000-4000-8000-0000000000a3";
const ctx = { siteUrl: "https://drive.example", unsubscribeUrl: "https://drive.example/baja/xyz" };

test("el catálogo tiene un valor por defecto para cada evento", () => {
  for (const e of EVENTS) assert.ok(DEFAULTS[e].channel && DEFAULTS[e].frequency);
});

test("el payload se limpia: rutas solo internas, textos acotados, sin control", () => {
  const p = safePayload({ title: "  Sesión\u0000 X  ", path: "https://malo.example/x", count: -3, actorName: "A".repeat(500) });
  assert.equal(p.title, "Sesión X");
  assert.equal(p.path, "/");
  assert.equal(p.count, undefined);
  assert.ok((p.actorName ?? "").length <= 80);
  assert.equal(safePayload({ title: "t", path: "/sesiones/abc?foto=1" }).path, "/sesiones/abc?foto=1");
  assert.equal(safePayload({ title: "t", path: "//evil.example" }).path, "/");
});

test("12 subidas se suman en UN aviso: «12 archivos nuevos en …»", () => {
  const items = Array.from({ length: 12 }, () => ({ title: "Sesión X", path: "/sesiones/1", count: 1 }));
  const merged = mergePayloads(items);
  assert.equal(merged.count, 12);
  assert.equal(describe("upload_published", merged), "12 archivos nuevos en Sesión X");
  assert.equal(describe("upload_published", { title: "S", path: "/", count: 1 }), "1 archivo nuevo en S");
});

test("correo instantáneo: texto y HTML con un enlace a la plataforma y baja; sin URLs firmadas", () => {
  const mail = renderInstant([{ event: "comment", payload: { title: "Vídeo <b>1</b>", path: "/archivo/abc", actorName: "Ana" } }], ctx);
  assert.equal(mail.subject, "Ana comentó en Vídeo <b>1</b>");
  assert.match(mail.text, /https:\/\/drive\.example\/archivo\/abc/);
  assert.match(mail.html, /href="https:\/\/drive\.example\/archivo\/abc"/);
  assert.ok(mail.html.includes("&lt;b&gt;1&lt;/b&gt;") && !mail.html.includes("<b>1</b>"), "el texto de usuario se escapa");
  assert.match(mail.html, /baja\/xyz/);
  assert.ok(!/X-Amz|Signature|storage|vault/i.test(mail.text + mail.html));
  assert.ok(!/<img/i.test(mail.html), "sin imágenes");
});

test("resumen diario: agrupado por artista y por destino, con una sola carta", () => {
  const items = [
    ...Array.from({ length: 5 }, () => ({ event: "upload_published" as const, payload: { title: "Sesión 1", path: "/sesiones/1", count: 1, artistName: "Pepito" } })),
    { event: "comment" as const, payload: { title: "Foto", path: "/archivo/2", actorName: "Lía", artistName: "Marta" } },
    { event: "beat_shared" as const, payload: { title: "Noche", path: "/espacio/pepito/beats", artistName: "Pepito" } },
  ];
  const groups = groupForDigest(items);
  assert.deepEqual(groups.map((g) => g.artist), ["Marta", "Pepito"]);
  assert.equal(groups[1]?.lines.length, 2);
  assert.equal(groups[1]?.lines[0]?.text, "5 archivos nuevos en Sesión 1");
  const mail = renderDigest(items, { ...ctx, dateLabel: "20 nov" });
  assert.equal(mail.subject, "Resumen del día: 3 novedades");
  assert.match(mail.text, /PEPITO/);
});

test("enlace de baja: firmado, ligado a persona y tipo, sin sesión", () => {
  const t = signUnsubscribe(USER, "comment", "clave-de-baja");
  assert.deepEqual(verifyUnsubscribe(t, "clave-de-baja"), { userId: USER, event: "comment" });
  assert.deepEqual(verifyUnsubscribe(signUnsubscribe(USER, "digest", "clave-de-baja"), "clave-de-baja"), { userId: USER, event: "digest" });
  assert.equal(verifyUnsubscribe(t, "otra-clave"), null);
  assert.equal(verifyUnsubscribe(`${t}x`, "clave-de-baja"), null);
  const forged = `${Buffer.from(`${USER}|mention`).toString("base64url")}.${t.split(".")[1]}`;
  assert.equal(verifyUnsubscribe(forged, "clave-de-baja"), null, "no se puede cambiar el tipo");
  assert.equal(verifyUnsubscribe("", "k"), null);
});
