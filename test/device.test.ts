import { describe, expect, it } from "vitest";
import { canOpenBrowser, deviceName } from "../src/lib/device.ts";

describe("deviceName", () => {
  it("uses the hostname", () => {
    expect(deviceName({}, "ada-macbook-pro")).toBe("ada-macbook-pro");
  });

  it("names cloud editors by their workspace, not their random hostname", () => {
    expect(deviceName({ CODESPACE_NAME: "shiny-train" }, "x")).toBe("GitHub Codespaces: shiny-train");
    expect(deviceName({ REPL_SLUG: "weather", REPL_OWNER: "ada" }, "x")).toBe("Replit: ada/weather");
  });

  it("is never blank", () => {
    expect(deviceName({}, "  ")).toBe("Unknown device");
  });
});

describe("canOpenBrowser", () => {
  it("opens on a desktop", () => {
    expect(canOpenBrowser({}, "darwin")).toBe(true);
    expect(canOpenBrowser({}, "win32")).toBe(true);
    expect(canOpenBrowser({ DISPLAY: ":0" }, "linux")).toBe(true);
  });

  it("doesn't over SSH, in CI, or in cloud editors", () => {
    expect(canOpenBrowser({ SSH_CONNECTION: "1 2 3 4" }, "darwin")).toBe(false);
    expect(canOpenBrowser({ CI: "true" }, "linux")).toBe(false);
    expect(canOpenBrowser({ CODESPACES: "true", DISPLAY: ":0" }, "linux")).toBe(false);
    expect(canOpenBrowser({ REPL_ID: "x" }, "linux")).toBe(false);
  });

  it("doesn't on Linux with no display, except under WSL", () => {
    expect(canOpenBrowser({}, "linux")).toBe(false);
    expect(canOpenBrowser({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe(true);
  });
});
