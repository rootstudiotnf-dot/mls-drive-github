import assert from "node:assert/strict";
import { test } from "node:test";
import { sign, signedHeaders, verify } from "./signing.ts";
import * as service from "../../../services/transcoder/signing.mjs";

const SECRET = "k".repeat(40);
const header = (h: Record<string, string>) => (name: string) => h[name] ?? null;

test("firma: la web y el servicio firman y verifican de forma compatible", () => {
  const body = JSON.stringify({ jobId: "x", ñ: "acentos ✓" });
  assert.equal(sign(SECRET, "1700000000000", "ab".repeat(8), body), service.sign(SECRET, "1700000000000", "ab".repeat(8), body));
  const fromWeb = signedHeaders(SECRET, body);
  assert.equal(service.verify(SECRET, fromWeb, body).ok, true);
  const fromService = service.signedHeaders(SECRET, body);
  assert.equal(verify(SECRET, header(fromService), body).ok, true);
});

test("firma: rechaza cuerpo manipulado, secreto distinto, marca antigua y cabeceras ausentes o mal formadas", () => {
  const body = '{"a":1}';
  const h = signedHeaders(SECRET, body, 1_700_000_000_000);
  const now = 1_700_000_000_000;
  assert.deepEqual(verify(SECRET, header(h), body, now).ok, true);
  assert.deepEqual(verify(SECRET, header(h), body + " ", now), { ok: false, reason: "signature" });
  assert.deepEqual(verify("z".repeat(40), header(h), body, now), { ok: false, reason: "signature" });
  assert.deepEqual(verify(SECRET, header(h), body, now + 5 * 60 * 1000 + 1), { ok: false, reason: "stale" });
  assert.deepEqual(verify(SECRET, header(h), body, now - 5 * 60 * 1000 - 1), { ok: false, reason: "stale" });
  assert.deepEqual(verify(SECRET, () => null, body, now), { ok: false, reason: "missing" });
  assert.deepEqual(verify(SECRET, header({ ...h, "x-nonce": "../../" }), body, now), { ok: false, reason: "format" });
  assert.deepEqual(verify(SECRET, header({ ...h, "x-signature": "00" }), body, now), { ok: false, reason: "signature" });
});
