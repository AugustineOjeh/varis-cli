// Links that open a GitHub issue already filled in.
//
// The bug report form (.github/ISSUE_TEMPLATE/bug_report.yml) takes each
// field's id as a URL parameter, so the CLI fills in what it knows: the
// version, the operating system, the command, the error, and the request ID.
// The developer adds what only they know, following
// docs/reporting-issues.md.

import { ISSUES_URL, REPORTING_GUIDE_URL } from "./constants.ts";
import { VERSION } from "./version.ts";

export type BugContext = {
  /** The command as run, for example "varis publish weather". */
  command?: string;
  /** What went wrong, as the CLI printed it. */
  error?: string;
  requestId?: string;
};

/** Long errors are cut, so the link stays well under GitHub's URL limit. */
const MAX_ERROR_CHARS = 1_000;

export function bugReportUrl(context: BugContext = {}): string {
  const params = new URLSearchParams({
    template: "bug_report.yml",
    version: VERSION,
    os: `${process.platform} ${process.arch}`,
  });
  if (context.command) params.set("command", context.command);
  if (context.requestId) params.set("request_id", context.requestId);
  if (context.error) {
    params.set(
      "output",
      context.error.length > MAX_ERROR_CHARS
        ? `${context.error.slice(0, MAX_ERROR_CHARS)}…`
        : context.error,
    );
  }
  return `${ISSUES_URL}/new?${params.toString()}`;
}

/** Two lines to print under an error that is our fault, not the developer's. */
export function reportLines(context: BugContext = {}): string[] {
  return [
    `Report it on GitHub; this link fills in the details: ${bugReportUrl(context)}`,
    `How to write a report we can act on: ${REPORTING_GUIDE_URL}`,
  ];
}
