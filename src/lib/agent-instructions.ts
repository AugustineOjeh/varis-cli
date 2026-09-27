// The note varis init leaves for coding agents in the project.
//
// AGENTS.md gets a block between two markers, pointing agents at the SDK's
// own instructions. Only the text between the markers is ever rewritten, so
// everything the developer wrote around it survives. CLAUDE.md gets the
// `@AGENTS.md` import that makes Claude Code read AGENTS.md.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const BLOCK_BEGIN = "<!-- BEGIN VARIS: managed by varis init; edits here are replaced -->";
export const BLOCK_END = "<!-- END VARIS -->";

export const BLOCK_BODY = `## Varis

This project publishes services that AI agents discover and pay to call,
through Varis. Before you change a service's definition or its handler, read
the Varis SDK's instructions for coding agents:

- TypeScript: \`node_modules/@usevaris/sdk/docs/agents.md\`

Then run \`varis build\` and commit the updated \`varis.json\`. Never edit the
\`services\` list in \`varis.json\` by hand; \`varis build\` owns it. Change
\`owner_id\`, \`base_url\`, or \`test_base_url\` only with \`varis init\`, and
only when the developer asks. Never put a token or other secret in \`varis.json\`.`;

const BLOCK = `${BLOCK_BEGIN}\n${BLOCK_BODY}\n${BLOCK_END}`;

export type FileChange = "created" | "updated" | "unchanged";

/**
 * Adds the Varis block to AGENTS.md, creating the file if needed. Replaces
 * an existing block's contents in place; adds one at the end otherwise.
 */
export async function upsertAgentsBlock(projectDir: string): Promise<FileChange> {
  const file = path.join(projectDir, "AGENTS.md");
  const existing = await readIfExists(file);

  if (existing === null) {
    await writeFile(file, `# Instructions for coding agents\n\n${BLOCK}\n`);
    return "created";
  }

  const begin = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END, begin);

  let next: string;
  if (begin !== -1 && end !== -1) {
    next = existing.slice(0, begin) + BLOCK + existing.slice(end + BLOCK_END.length);
  } else {
    const separator = existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
      ? "\n"
      : "\n\n";
    next = `${existing}${separator}${BLOCK}\n`;
  }

  if (next === existing) return "unchanged";
  await writeFile(file, next);
  return "updated";
}

/** Makes sure CLAUDE.md imports AGENTS.md, creating CLAUDE.md if needed. */
export async function ensureClaudeImport(projectDir: string): Promise<FileChange> {
  const file = path.join(projectDir, "CLAUDE.md");
  const existing = await readIfExists(file);

  if (existing === null) {
    await writeFile(file, "@AGENTS.md\n");
    return "created";
  }
  if (existing.split(/\r?\n/).some((line) => line.trim() === "@AGENTS.md")) {
    return "unchanged";
  }
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await writeFile(file, `${existing}${separator}@AGENTS.md\n`);
  return "updated";
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return null;
    throw error;
  }
}
