import assert from "node:assert/strict";
import { test } from "node:test";
import { generateRecoveryCode, matchesRecoveryCode, newRecoverySet, normalizeRecoveryCode, RECOVERY_CODE_COUNT } from "./recovery.ts";

test("los códigos tienen formato XXXX-XXXX sin caracteres ambiguos", () => {
  for (let i = 0; i < 50; i++) assert.match(generateRecoveryCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

test("un conjunto son 10 códigos distintos y en la base de datos solo hay hashes con sal", () => {
  const set = newRecoverySet();
  assert.equal(set.codes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(set.codes).size, RECOVERY_CODE_COUNT);
  for (const [i, row] of set.rows.entries()) {
    assert.match(row.code_hash, /^[0-9a-f]{64}$/);
    assert.ok(!row.code_hash.includes(normalizeRecoveryCode(set.codes[i] as string)));
  }
  assert.equal(new Set(set.rows.map((r) => r.salt)).size, RECOVERY_CODE_COUNT);
});

test("se acepta con minúsculas, espacios o sin guion; se rechaza otro código", () => {
  const set = newRecoverySet(2);
  const code = set.codes[0] as string;
  const row = set.rows[0] as { salt: string; code_hash: string };
  assert.equal(matchesRecoveryCode(code, row), true);
  assert.equal(matchesRecoveryCode(code.toLowerCase().replace("-", " "), row), true);
  assert.equal(matchesRecoveryCode(code.replace("-", ""), row), true);
  assert.equal(matchesRecoveryCode(set.codes[1] as string, row), false);
  assert.equal(matchesRecoveryCode("", row), false);
});
