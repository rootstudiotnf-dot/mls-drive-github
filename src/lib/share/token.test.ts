import assert from "node:assert/strict";
import { test } from "node:test";
import { generateToken, hashIp, hashPassword, hashToken, isExpiryDays, isTokenShape, linkState, sameHash, signUnlocked, summarizeUserAgent, verifyPasswordHash, verifyUnlocked } from "./token.ts";

test("el token tiene 192 bits, es único y su hash es SHA-256 (nunca el token)", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const t = generateToken();
    assert.equal(isTokenShape(t), true);
    assert.equal(Buffer.from(t, "base64url").length, 24);
    assert.match(hashToken(t), /^[0-9a-f]{64}$/);
    assert.ok(!hashToken(t).includes(t));
    seen.add(t);
  }
  assert.equal(seen.size, 200);
});

test("se rechazan tokens con forma inválida", () => {
  for (const bad of ["", "abc", "a".repeat(31), "a".repeat(33), "../".repeat(11), "a b".repeat(11), undefined, 42]) assert.equal(isTokenShape(bad), false);
});

test("comparación de hashes en tiempo constante", () => {
  const h = hashToken("x".repeat(32));
  assert.equal(sameHash(h, hashToken("x".repeat(32))), true);
  assert.equal(sameHash(h, hashToken("y".repeat(32))), false);
  assert.equal(sameHash(h, "zz"), false);
  assert.equal(sameHash("", ""), false);
});

test("contraseña: scrypt con sal, se verifica y no se puede leer", () => {
  const a = hashPassword("secreta-123");
  const b = hashPassword("secreta-123");
  assert.notEqual(a, b, "sal distinta cada vez");
  assert.ok(a.startsWith("scrypt$") && !a.includes("secreta"));
  assert.equal(verifyPasswordHash("secreta-123", a), true);
  assert.equal(verifyPasswordHash("secreta-124", a), false);
  assert.equal(verifyPasswordHash("", a), false);
  assert.equal(verifyPasswordHash("x".repeat(500), a), false);
  assert.equal(verifyPasswordHash("secreta-123", "basura"), false);
});

test("las IPs no se guardan en claro y dependen de la sal", () => {
  const a = hashIp("203.0.113.9", "sal-1");
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.ok(!a.includes("203"));
  assert.notEqual(a, hashIp("203.0.113.9", "sal-2"));
  assert.notEqual(a, hashIp("203.0.113.10", "sal-1"));
});

test("resumen del navegador: corto y sin la cabecera completa", () => {
  assert.equal(summarizeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"), "Chrome · Windows");
  assert.equal(summarizeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17 Mobile Safari/604.1"), "Safari · iOS");
  assert.equal(summarizeUserAgent(null), "Otro");
  assert.ok(summarizeUserAgent("x".repeat(5000)).length < 30);
});

test("cookie de contraseña validada: ligada al enlace, firmada y con caducidad", () => {
  const now = 1_000_000;
  const v = signUnlocked("link-1", now + 60_000, "clave-secreta-de-prueba");
  assert.equal(verifyUnlocked(v, "link-1", "clave-secreta-de-prueba", now), true);
  assert.equal(verifyUnlocked(v, "link-2", "clave-secreta-de-prueba", now), false, "otro enlace");
  assert.equal(verifyUnlocked(v, "link-1", "otra-clave", now), false, "otra clave");
  assert.equal(verifyUnlocked(v, "link-1", "clave-secreta-de-prueba", now + 120_000), false, "caducada");
  assert.equal(verifyUnlocked(`${now + 60_000}.x`, "link-1", "clave-secreta-de-prueba", now), false);
  assert.equal(verifyUnlocked(undefined, "link-1", "k", now), false);
});

test("caducidades permitidas y estado del enlace", () => {
  for (const ok of [1, 7, 30]) assert.equal(isExpiryDays(ok), true);
  for (const bad of [0, 2, 31, "7", null]) assert.equal(isExpiryDays(bad), false);
  const now = Date.parse("2026-11-20T12:00:00Z");
  assert.equal(linkState({ revoked_at: null, expires_at: "2026-11-21T12:00:00Z" }, now), "active");
  assert.equal(linkState({ revoked_at: null, expires_at: "2026-11-20T11:59:59Z" }, now), "expired");
  assert.equal(linkState({ revoked_at: "2026-11-20T10:00:00Z", expires_at: "2026-11-30T12:00:00Z" }, now), "revoked");
});
