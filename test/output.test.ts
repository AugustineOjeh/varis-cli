import { describe, expect, it } from "vitest";
import { rowsFor, shouldStyle } from "../src/lib/output.ts";

describe("shouldStyle", () => {
  it("colours a terminal, and nothing else", () => {
    expect(shouldStyle({ isTTY: true }, {})).toBe(true);
    expect(shouldStyle({ isTTY: false }, {})).toBe(false);
    expect(shouldStyle({}, {})).toBe(false);
  });

  it("honours NO_COLOR over everything, and FORCE_COLOR over a pipe", () => {
    expect(shouldStyle({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(shouldStyle({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
    expect(shouldStyle({ isTTY: true }, { NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
  });
});

describe("rowsFor", () => {
  it("counts the rows a status line wraps onto", () => {
    expect(rowsFor("short", 80)).toBe(1);
    expect(rowsFor("x".repeat(80), 80)).toBe(1);
    expect(rowsFor("x".repeat(89), 80)).toBe(2);
    expect(rowsFor("x".repeat(89), 40)).toBe(3);
  });

  it("ignores colour codes, which take no space", () => {
    expect(rowsFor(`\x1b[32m${"x".repeat(80)}\x1b[0m`, 80)).toBe(1);
  });

  it("is one row for an empty line or an unknown width", () => {
    expect(rowsFor("", 80)).toBe(1);
    expect(rowsFor("x".repeat(10), 0)).toBe(10);
  });
});
