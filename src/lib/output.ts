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

function createProcessOutput(): Output {
  const live = process.stderr.isTTY === true;
  let statusShown = false;

  // Ends a status line before anything else is written, so it isn't
  // overwritten mid-line.
  const endStatus = () => {
    if (statusShown) {
      process.stderr.write("\n");
      statusShown = false;
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
      if (live) {
        // Carriage return, then clear the line, then write over it.
        process.stderr.write(`\r\x1b[2K${text}`);
        statusShown = true;
      } else {
        process.stderr.write(`${text}\n`);
      }
    },
    styled: shouldStyle(process.stderr),
  };
}

export const processOutput: Output = createProcessOutput();
