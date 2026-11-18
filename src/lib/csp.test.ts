import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCsp, cleanOrigins, makeNonce } from "./csp.ts";

test("csp: producción sin unsafe-inline ni unsafe-eval en scripts, con nonce y strict-dynamic", () => {
  const csp = buildCsp({ nonce: "abc", storageOrigins: ["https://acct.r2.cloudflarestorage.com/bucket/x"] });
  const script = csp.split("; ").find((d) => d.startsWith("script-src ")) ?? "";
  assert.match(script, /'nonce-abc'/);
  assert.match(script, /'strict-dynamic'/);
  assert.doesNotMatch(script, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /upgrade-insecure-requests/);
  assert.match(csp, /connect-src 'self' https:\/\/acct\.r2\.cloudflarestorage\.com(;|$)/);
});

test("csp: desarrollo añade unsafe-eval y websockets, pero no upgrade-insecure-requests", () => {
  const csp = buildCsp({ nonce: "abc", dev: true });
  assert.match(csp, /'unsafe-eval'/);
  assert.match(csp, /ws:/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
});

test("csp: solo se aceptan orígenes http(s) bien formados (nada de inyectar directivas)", () => {
  assert.deepEqual(cleanOrigins(["https://a.example/x?y", "javascript:alert(1)", "not a url", "https://a.example; script-src *", undefined, null, "http://localhost:9000"]), ["https://a.example", "http://localhost:9000"]);
});

test("csp: el nonce es distinto en cada petición y tiene 128 bits", () => {
  const a = makeNonce();
  const b = makeNonce();
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, "base64").length, 16);
});
