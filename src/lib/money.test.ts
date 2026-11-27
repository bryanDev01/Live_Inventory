import { test } from "node:test";
import assert from "node:assert/strict";
import { cupEquivalent, formatRounded, parseDecimal, profitPercent } from "./money.ts";

test("parseDecimal rejects thousands separators and commas", () => {
  assert.throws(() => parseDecimal("1,5"));
  assert.throws(() => parseDecimal("1.000,50"));
  assert.throws(() => parseDecimal("-1"));
});

test("cupEquivalent multiplies exactly and rounds to 2 decimals", () => {
  assert.equal(cupEquivalent("10", "500"), "5000.00");
  assert.equal(cupEquivalent("0.1", "0.3"), "0.03");
  assert.equal(cupEquivalent("3.33", "1"), "3.33");
});

test("rounding is half up", () => {
  assert.equal(cupEquivalent("0.125", "1"), "0.13");
  assert.equal(formatRounded(parseDecimal("2.5"), 0), "3");
  assert.equal(formatRounded(parseDecimal("0.004"), 2), "0.00");
});

test("margin percent uses the sale price as base", () => {
  assert.equal(profitPercent("10", "12", "margin"), "16.67");
  assert.equal(profitPercent("10", "8", "margin"), "-25.00");
});

test("markup percent uses the purchase price as base", () => {
  assert.equal(profitPercent("10", "12", "markup"), "20.00");
  assert.equal(profitPercent("10", "8", "markup"), "-20.00");
});

test("zero denominators return null instead of dividing", () => {
  assert.equal(profitPercent("10", "0", "margin"), null);
  assert.equal(profitPercent("0", "5", "markup"), null);
});

test("equal purchase and sale give zero profit", () => {
  assert.equal(profitPercent("7.5", "7.5", "margin"), "0.00");
  assert.equal(profitPercent("7.5", "7.50", "markup"), "0.00");
});
