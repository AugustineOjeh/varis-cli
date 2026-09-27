/**
 * Where a command writes. Commands never touch process.stdout directly, so
 * tests can capture exactly what a developer would see.
 *
 * stdout carries the command's result; stderr carries errors and progress,
 * so `varis ... > file` keeps only the result.
 */
export type Output = {
  out: (text: string) => void;
  err: (text: string) => void;
  /**
   * A progress line that the next one replaces, such as "Checking for
   * approval". On a terminal it rewrites one line in place; elsewhere, such
   * as a CI log, each is its own line. The next out or err ends it.
   */
  status: (text: string) => void;
  /** True when writing to a terminal that shows colour. */
  styled: boolean;
};

/**
 * Colour only on a real terminal, and never when NO_COLOR is set
 * (https://no-color.org). FORCE_COLOR turns it on regardless.
 */
export function shouldStyle(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return true;
  return stream.isTTY === true;
}

/** Removes colour codes, which take no space on screen. */
const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * How many screen rows `text` takes in a terminal `columns` wide. A line
 * wider than the terminal wraps onto more rows, and all of them must be
 * cleared, or each update leaves the earlier rows behind.
 */
export function rowsFor(text: string, columns: number): number {
  const width = Math.max(columns, 1);
  return Math.max(1, Math.ceil(visible(text).length / width));
}

function createProcessOutput(): Output {
  const live = process.stderr.isTTY === true;
  /** Rows the current status line takes, or 0 when none is shown. */
  let statusRows = 0;

  // Ends a status line before anything else is written, so it isn't
  // overwritten mid-line.
  const endStatus = () => {
    if (statusRows > 0) {
      process.stderr.write("\n");
      statusRows = 0;
    }
  };

  return {
    out: (text) => {
      endStatus();
      process.stdout.write(`${text}\n`);
    },
    err: (text) => {
      endStatus();
      process.stderr.write(`${text}\n`);
    },
    status: (text) => {
      if (!live) {
        process.stderr.write(`${text}\n`);
        return;
      }
      // Back to the first row of the previous status, however many rows it
      // wrapped onto, clear from there down, then write the new one.
      const up = statusRows > 1 ? `\x1b[${statusRows - 1}A` : "";
      process.stderr.write(`\r${up}\x1b[J${text}`);
      statusRows = rowsFor(text, process.stderr.columns ?? 80);
    },
    styled: shouldStyle(process.stderr),
  };
}

export const processOutput: Output = createProcessOutput();
