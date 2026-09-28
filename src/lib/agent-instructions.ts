// The note varis init leaves for coding agents in the project.
//
// AGENTS.md gets a block between two markers, pointing agents at the SDK's
// own instructions. Only the text between the markers is ever rewritten, so
// everything the developer wrote around it survives. CLAUDE.md gets the
// `@AGENTS.md` import that makes Claude Code read AGENTS.md.

import { readFile, rm, writeFile } from "node:fs/promises";
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

/** The header upsertAgentsBlock writes when it creates AGENTS.md. */
const CREATED_HEADER = "# Instructions for coding agents";

export type Removal = "removed" | "deleted" | "absent";

/**
 * Undoes upsertAgentsBlock, for varis dracarys: removes the Varis block and
 * the blank line before it. Deletes AGENTS.md when nothing is left but the
 * header varis init wrote, so a file init created leaves with it, and a
 * file the developer wrote keeps everything else.
 */
export async function removeAgentsBlock(projectDir: string): Promise<Removal> {
  const file = path.join(projectDir, "AGENTS.md");
  const existing = await readIfExists(file);
  if (existing === null) return "absent";

  const begin = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END, begin);
  if (begin === -1 || end === -1) return "absent";

  const before = existing.slice(0, begin).replace(/\n+$/, "");
  const after = existing.slice(end + BLOCK_END.length).replace(/^\n+/, "");
  const rest = [before, after].filter((part) => part.trim() !== "").join("\n\n");

  if (rest.trim() === "" || rest.trim() === CREATED_HEADER) {
    await rm(file);
    return "deleted";
  }
  await writeFile(file, `${rest.replace(/\n+$/, "")}\n`);
  return "removed";
}

/**
 * Undoes ensureClaudeImport, for varis dracarys, once AGENTS.md is gone:
 * removes the `@AGENTS.md` line, which would point at nothing, and deletes
 * CLAUDE.md when that line was all it held.
 */
export async function removeClaudeImport(projectDir: string): Promise<Removal> {
  const file = path.join(projectDir, "CLAUDE.md");
  const existing = await readIfExists(file);
  if (existing === null) return "absent";

  const lines = existing.split(/\r?\n/);
  const kept = lines.filter((line) => line.trim() !== "@AGENTS.md");
  if (kept.length === lines.length) return "absent";

  const rest = kept.join("\n").trim();
  if (rest === "") {
    await rm(file);
    return "deleted";
  }
  await writeFile(file, `${rest}\n`);
  return "removed";
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return null;
    throw error;
  }
}
