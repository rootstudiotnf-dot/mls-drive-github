import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCK_MS,
  nextFailureState,
  remainingSeconds,
  renewUnlock,
  signUnlock,
  UNLOCK_IDLE_MS,
  UNLOCK_MAX_MS,
  verifyUnlock,
  type UnlockPayload,
} from "./unlock-token.ts";

const SECRET = "s".repeat(40);
const ME = { userId: "user-1", sessionId: "sess-1" };
const base = (now: number): UnlockPayload => ({ u: "user-1", sid: "sess-1", iat: now, act: now });

test("un token recién firmado se acepta", () => {
  const now = 1_000_000;
  const token = signUnlock(base(now), SECRET);
  assert.equal(verifyUnlock(token, SECRET, ME, now + 1000).ok, true);
});

test("se rechaza sin token, con formato roto o con otra firma", () => {
  const now = 1_000_000;
  assert.deepEqual(verifyUnlock(undefined, SECRET, ME, now), { ok: false, reason: "missing" });
  assert.equal(verifyUnlock("abc", SECRET, ME, now).ok, false);
  const token = signUnlock(base(now), SECRET);
  assert.deepEqual(verifyUnlock(token, "x".repeat(40), ME, now), { ok: false, reason: "signature" });
  const [body, mac] = token.split(".");
  const tampered = Buffer.from(JSON.stringify({ ...base(now), u: "otro" })).toString("base64url");
  assert.deepEqual(verifyUnlock(`${tampered}.${mac}`, SECRET, ME, now), { ok: false, reason: "signature" });
  assert.equal(verifyUnlock(`${body}.`, SECRET, ME, now).ok, false);
});

test("está ligado a la persona y a la sesión", () => {
  const now = 1_000_000;
  const token = signUnlock(base(now), SECRET);
  assert.deepEqual(verifyUnlock(token, SECRET, { userId: "user-2", sessionId: "sess-1" }, now), { ok: false, reason: "owner" });
  assert.deepEqual(verifyUnlock(token, SECRET, { userId: "user-1", sessionId: "sess-2" }, now), { ok: false, reason: "owner" });
  assert.deepEqual(verifyUnlock(token, SECRET, { userId: "user-1", sessionId: "" }, now), { ok: false, reason: "owner" });
});

test("caduca a los 15 minutos de inactividad y la actividad lo renueva", () => {
  const now = 10_000_000;
  const token = signUnlock(base(now), SECRET);
  assert.equal(verifyUnlock(token, SECRET, ME, now + UNLOCK_IDLE_MS - 1).ok, true);
  assert.deepEqual(verifyUnlock(token, SECRET, ME, now + UNLOCK_IDLE_MS + 1), { ok: false, reason: "idle" });
  const renewed = signUnlock(renewUnlock(base(now), now + UNLOCK_IDLE_MS - 5), SECRET);
  assert.equal(verifyUnlock(renewed, SECRET, ME, now + UNLOCK_IDLE_MS + 60_000).ok, true);
});

test("caduca siempre a las 2 horas aunque haya actividad", () => {
  const now = 10_000_000;
  let payload = base(now);
  // actividad cada 10 minutos durante 2 horas y media
  for (let t = now; t <= now + UNLOCK_MAX_MS + 30 * 60_000; t += 10 * 60_000) payload = renewUnlock(payload, t);
  const token = signUnlock(payload, SECRET);
  assert.deepEqual(verifyUnlock(token, SECRET, ME, now + UNLOCK_MAX_MS + 1000), { ok: false, reason: "max" });
  assert.ok(payload.act <= payload.iat + UNLOCK_MAX_MS, "la renovación no pasa del máximo");
});

test("los tokens «del futuro» no valen", () => {
  const now = 10_000_000;
  const token = signUnlock({ u: "user-1", sid: "sess-1", iat: now + 3_600_000, act: now + 3_600_000 }, SECRET);
  assert.equal(verifyUnlock(token, SECRET, ME, now).ok, false);
});

test("vida restante de la cookie", () => {
  const now = 10_000_000;
  assert.equal(remainingSeconds(base(now), now), UNLOCK_IDLE_MS / 1000);
  assert.equal(remainingSeconds({ ...base(now), act: now + UNLOCK_MAX_MS }, now + UNLOCK_MAX_MS), 0);
});

test("5 fallos seguidos bloquean 15 minutos", () => {
  const now = 5_000;
  let state = { failures: 0, lockedUntil: null as number | null };
  for (let i = 1; i <= 4; i++) {
    state = nextFailureState(state.failures, now);
    assert.equal(state.lockedUntil, null);
    assert.equal(state.failures, i);
  }
  state = nextFailureState(state.failures, now);
  assert.equal(state.lockedUntil, now + LOCK_MS);
  assert.equal(state.failures, 0);
});
