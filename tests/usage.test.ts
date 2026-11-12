import assert from "node:assert/strict";
import test from "node:test";
import { record, render, type UsageLedger } from "../src/usage.ts";

const entry = "router/auto";

test("accumulates tokens and timing and dedupes physical models across routes", () => {
  const ledger: UsageLedger = new Map();
  record(ledger, entry, "physical", "terra", 1000, 10000);
  record(ledger, entry, "physical", "terra", 430, 10000);
  assert.equal(ledger.get(entry)?.size, 1);
  assert.equal(render(ledger, entry), "\u001b[2m\u21c4\u001b[0m \u001b[1mterra\u001b[22m: 100% · 71.5 t/s");
});

test("largest remainders sum to 100 and ties favor first-seen models", () => {
  const ledger: UsageLedger = new Map();
  for (const model of ["terra", "sol", "astra"]) record(ledger, entry, "physical", model, 1);
  const line = render(ledger, entry);
  assert.equal(line, "\u001b[2m\u21c4\u001b[0m terra: 34% | sol: 33% | \u001b[1mastra\u001b[22m: 33%");
  assert.equal([...line.matchAll(/(\d+)%/g)].reduce((sum, match) => sum + Number(match[1]), 0), 100);
  record(ledger, entry, "physical", "astra", 1);
  assert.equal(render(ledger, entry), "\u001b[2m\u21c4\u001b[0m terra: 25% | sol: 25% | \u001b[1mastra\u001b[22m: 50%");
});

test("preserves insertion order rather than ranking shares", () => {
  const ledger: UsageLedger = new Map();
  record(ledger, entry, "physical", "small", 1);
  record(ledger, entry, "physical", "large", 5);
  record(ledger, entry, "physical", "middle", 3);
  assert.equal(render(ledger, entry), "\u001b[2m\u21c4\u001b[0m small: 11% | large: 56% | \u001b[1mmiddle\u001b[22m: 33%");
});

test("untimed and zero-time records show tokens only", () => {
  const ledger: UsageLedger = new Map();
  record(ledger, entry, "physical", "terra", 2);
  record(ledger, entry, "physical", "sol", 2, 0);
  assert.equal(render(ledger, entry), "\u001b[2m\u21c4\u001b[0m terra: 50% | \u001b[1msol\u001b[22m: 50%");
});

test("unknown, empty, and invalid-token entries have no line", () => {
  const ledger: UsageLedger = new Map([[entry, new Map()]]);
  assert.equal(render(ledger, "unknown"), undefined);
  assert.equal(render(ledger, entry), undefined);
  for (const tokens of [0, -1, NaN, Infinity, -Infinity]) record(ledger, entry, "physical", "terra", tokens, 1000);
  assert.equal(render(ledger, entry), undefined);
});

test("entry and physical provider identities remain separate", () => {
  const ledger: UsageLedger = new Map();
  record(ledger, entry, "one", "shared", 1);
  record(ledger, entry, "two", "shared", 3);
  record(ledger, "router/other", "one", "shared", 10);
  assert.equal(render(ledger, entry), "\u001b[2m\u21c4\u001b[0m shared: 25% | \u001b[1mshared\u001b[22m: 75%");
  assert.equal(render(ledger, "router/other"), "\u001b[2m\u21c4\u001b[0m \u001b[1mshared\u001b[22m: 100%");
  record(ledger, entry, "a/b", "c", 1);
  record(ledger, entry, "a", "b/c", 1);
  assert.equal(ledger.get(entry)?.size, 4);
});

test("only the latest counted model label is ANSI bold, including a deduped model", () => {
  const ledger: UsageLedger = new Map();
  record(ledger, entry, "physical", "terra", 1);
  record(ledger, entry, "physical", "sol", 1);
  assert.equal(render(ledger, entry), "\u001b[2m\u21c4\u001b[0m terra: 50% | \u001b[1msol\u001b[22m: 50%");
  record(ledger, entry, "physical", "terra", 1);
  assert.equal(render(ledger, entry), "\u001b[2m\u21c4\u001b[0m \u001b[1mterra\u001b[22m: 67% | sol: 33%");
  for (const tokens of [0, -1, NaN, Infinity]) record(ledger, entry, "physical", "sol", tokens);
  assert.equal(render(ledger, entry), "\u001b[2m\u21c4\u001b[0m \u001b[1mterra\u001b[22m: 67% | sol: 33%");
  assert.equal(ledger.get(entry)?.size, 2);
});

test("invalid elapsed times do not poison cumulative speed", () => {
  const ledger: UsageLedger = new Map();
  for (const elapsed of [NaN, Infinity, -1]) record(ledger, entry, "physical", "terra", 1, elapsed);
  record(ledger, entry, "physical", "terra", 7, 1000);
  assert.equal(render(ledger, entry), "\u001b[2m\u21c4\u001b[0m \u001b[1mterra\u001b[22m: 100% · 10.0 t/s");
});
