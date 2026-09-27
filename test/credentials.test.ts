import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CredentialsLocation,
  credentialsPath,
  deleteToken,
  parseCredentials,
  readToken,
  saveToken,
  serialiseCredentials,
} from "../src/lib/credentials.ts";

const PROD = "https://api.varis.my";
const LOCAL = "http://localhost:3000/api";
const TOKEN_A = `var_dt_${"a".repeat(40)}`;
const TOKEN_B = `var_dt_${"b".repeat(40)}`;

let home: string;
let location: CredentialsLocation;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "varis-cli-home-"));
  location = { env: {}, platform: process.platform, home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const modeOf = async (file: string) => (await stat(file)).mode & 0o777;

describe("credentialsPath", () => {
  it("uses ~/.config/varis on macOS and Linux", () => {
    expect(credentialsPath({ env: {}, platform: "darwin", home: "/Users/ada" }))
      .toBe("/Users/ada/.config/varis/credentials.toml");
    expect(credentialsPath({ env: {}, platform: "linux", home: "/home/ada" }))
      .toBe("/home/ada/.config/varis/credentials.toml");
  });

  it("honours an absolute XDG_CONFIG_HOME, and ignores a relative one", () => {
    expect(
      credentialsPath({ env: { XDG_CONFIG_HOME: "/xdg" }, platform: "linux", home: "/home/ada" }),
    ).toBe("/xdg/varis/credentials.toml");
    expect(
      credentialsPath({ env: { XDG_CONFIG_HOME: "rel" }, platform: "linux", home: "/home/ada" }),
    ).toBe("/home/ada/.config/varis/credentials.toml");
  });

  it("uses %APPDATA%\\varis on Windows", () => {
    expect(
      credentialsPath({
        env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
        platform: "win32",
        home: "C:\\Users\\Ada",
      }),
    ).toBe("C:\\Users\\Ada\\AppData\\Roaming\\varis\\credentials.toml");
  });
});

describe("a missing file", () => {
  it("reads as signed out", async () => {
    expect(await readToken(PROD, location)).toEqual({ status: "signed_out" });
  });

  it("is created, folder and all, on save", async () => {
    await saveToken(PROD, TOKEN_A, location);
    expect(await readToken(PROD, location)).toEqual({
      status: "signed_in",
      token: TOKEN_A,
    });
  });
});

describe("tokens per API origin", () => {
  it("keeps production and local tokens apart", async () => {
    await saveToken(PROD, TOKEN_A, location);
    await saveToken(LOCAL, TOKEN_B, location);

    expect(await readToken(PROD, location)).toMatchObject({ token: TOKEN_A });
    expect(await readToken(LOCAL, location)).toMatchObject({ token: TOKEN_B });
    expect(await readToken("https://other.example", location)).toEqual({
      status: "signed_out",
    });
  });

  it("replaces an origin's token on a new sign-in", async () => {
    await saveToken(PROD, TOKEN_A, location);
    await saveToken(PROD, TOKEN_B, location);
    expect(await readToken(PROD, location)).toMatchObject({ token: TOKEN_B });
  });

  it("removes one origin's token and keeps the other", async () => {
    await saveToken(PROD, TOKEN_A, location);
    await saveToken(LOCAL, TOKEN_B, location);

    expect(await deleteToken(PROD, location)).toBe(true);
    expect(await readToken(PROD, location)).toEqual({ status: "signed_out" });
    expect(await readToken(LOCAL, location)).toMatchObject({ token: TOKEN_B });
  });

  it("deletes the file once the last token is removed", async () => {
    await saveToken(PROD, TOKEN_A, location);
    expect(await deleteToken(PROD, location)).toBe(true);
    await expect(stat(credentialsPath(location))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports nothing removed when signed out", async () => {
    expect(await deleteToken(PROD, location)).toBe(false);
  });

  it("refuses to save something that isn't a device token", async () => {
    await expect(saveToken(PROD, "var_ak_nope", location)).rejects.toThrow();
  });
});

describe("a corrupt file", () => {
  async function writeRaw(text: string) {
    const file = credentialsPath(location);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, { mode: 0o600 });
  }

  it("reads as corrupt with the path and a reason, rather than throwing", async () => {
    await writeRaw("this is not toml at all");
    const result = await readToken(PROD, location);
    expect(result).toMatchObject({
      status: "corrupt",
      path: credentialsPath(location),
    });
    expect((result as { reason: string }).reason).toContain("line 1");
  });

  it("rejects a token that isn't a device token", async () => {
    await writeRaw(`["${PROD}"]\ntoken = "var_ak_${"a".repeat(40)}"\n`);
    expect(await readToken(PROD, location)).toMatchObject({ status: "corrupt" });
  });

  it("rejects a token outside any section, and a duplicate section", () => {
    expect(parseCredentials(`token = "${TOKEN_A}"`).ok).toBe(false);
    expect(
      parseCredentials(`["${PROD}"]\ntoken = "${TOKEN_A}"\n["${PROD}"]\n`).ok,
    ).toBe(false);
  });

  it("is replaced, not merged, by a new sign-in", async () => {
    await writeRaw("garbage");
    await saveToken(PROD, TOKEN_A, location);
    expect(await readToken(PROD, location)).toMatchObject({ token: TOKEN_A });
  });
});

describe("the format", () => {
  it("round-trips, sorted by origin, with comments ignored", () => {
    const tokens = new Map([[PROD, TOKEN_A], [LOCAL, TOKEN_B]]);
    const text = serialiseCredentials(tokens);
    expect(text.indexOf(LOCAL)).toBeLessThan(text.indexOf(PROD));
    const parsed = parseCredentials(text);
    expect(parsed.ok && [...parsed.tokens]).toEqual([[LOCAL, TOKEN_B], [PROD, TOKEN_A]]);
  });

  it("accepts Windows line endings", () => {
    const parsed = parseCredentials(`["${PROD}"]\r\ntoken = "${TOKEN_A}"\r\n`);
    expect(parsed.ok).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("file permissions", () => {
  it("creates the file readable only by its owner, in a private folder", async () => {
    await saveToken(PROD, TOKEN_A, location);
    const file = credentialsPath(location);
    expect(await modeOf(file)).toBe(0o600);
    expect(await modeOf(path.dirname(file))).toBe(0o700);
  });

  it("tightens a file others can read, on read", async () => {
    await saveToken(PROD, TOKEN_A, location);
    const file = credentialsPath(location);
    await chmod(file, 0o644);

    await readToken(PROD, location);
    expect(await modeOf(file)).toBe(0o600);
  });

  it("keeps 0600 after rewriting", async () => {
    await saveToken(PROD, TOKEN_A, location);
    await saveToken(LOCAL, TOKEN_B, location);
    expect(await modeOf(credentialsPath(location))).toBe(0o600);
  });

  it("leaves no temporary file behind", async () => {
    await saveToken(PROD, TOKEN_A, location);
    const entries = await readFile(credentialsPath(location), "utf8");
    expect(entries).toContain(TOKEN_A);
    expect(await readdir(path.dirname(credentialsPath(location)))).toEqual([
      "credentials.toml",
    ]);
  });
});
