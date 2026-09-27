import { describe, expect, it } from "vitest";
import { shouldStyle } from "../src/lib/output.ts";

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
