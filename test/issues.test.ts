import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ISSUES_URL, REPORTING_GUIDE_URL } from "../src/lib/constants.ts";
import { bugReportUrl, reportLines } from "../src/lib/issues.ts";
import { VERSION } from "../src/lib/version.ts";

function paramsOf(url: string) {
  expect(url.startsWith(`${ISSUES_URL}/new?`)).toBe(true);
  return new URL(url).searchParams;
}

describe("bugReportUrl", () => {
  it("opens the bug form with the version and platform filled in", () => {
    const params = paramsOf(bugReportUrl());
    expect(params.get("template")).toBe("bug_report.yml");
    expect(params.get("version")).toBe(VERSION);
    expect(params.get("os")).toBe(`${process.platform} ${process.arch}`);
  });

  it("fills in the command, the error, and the request ID when known", () => {
    const params = paramsOf(
      bugReportUrl({
        command: "varis publish weather",
        error: "Varis had a problem (HTTP 500)",
        requestId: "var_req_42",
      }),
    );
    expect(params.get("command")).toBe("varis publish weather");
    expect(params.get("output")).toBe("Varis had a problem (HTTP 500)");
    expect(params.get("request_id")).toBe("var_req_42");
  });

  it("cuts a long error, so the link stays short enough for GitHub", () => {
    const params = paramsOf(bugReportUrl({ error: "x".repeat(5_000) }));
    expect(params.get("output")!.length).toBeLessThanOrEqual(1_001);
  });

  it("uses field ids the form declares", async () => {
    
    const form = await readFile(".github/ISSUE_TEMPLATE/bug_report.yml", "utf8");
    for (const id of ["version", "os", "command", "output", "request_id"]) {
      expect(form).toContain(`id: ${id}\n`);
    }
  });
});

describe("reportLines", () => {
  it("gives the pre-filled link and the reporting guide", () => {
    const [link, guide] = reportLines({ command: "varis build" });
    expect(link).toContain(`${ISSUES_URL}/new?`);
    expect(guide).toContain(REPORTING_GUIDE_URL);
  });
});
