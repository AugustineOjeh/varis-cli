// Questions the CLI asks the developer: an arrow-key list, and a line of
// text. Commands take a Prompter, so tests answer in memory.
//
// Prompts only run on a terminal. Without one, as in CI or a pipe,
// `interactive` is false, and a command must use flags or fail with a
// message naming the flag, never wait for input that can't arrive.

import readline from "node:readline";

export type Choice<T> = { label: string; hint?: string; value: T };

export type Prompter = {
  interactive: boolean;
  /**
   * Up and Down (or k and j) to move, Enter to choose. Resolves to the
   * chosen value, or null if the developer pressed Ctrl-C or Escape.
   */
  select<T>(question: string, choices: Choice<T>[], initial?: number): Promise<T | null>;
  /**
   * One line of text. Enter alone gives `defaultValue`, or "" without one.
   * Resolves to null on Ctrl-C.
   */
  input(question: string, defaultValue?: string): Promise<string | null>;
};

const ESC = "\x1b[";
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_LINE = `${ESC}2K`;
const up = (lines: number) => (lines > 0 ? `${ESC}${lines}A` : "");

export function terminalPrompter(
  stdin: typeof process.stdin = process.stdin,
  stderr: typeof process.stderr = process.stderr,
): Prompter {
  const interactive = stdin.isTTY === true && stderr.isTTY === true;

  return {
    interactive,

    select<T>(question: string, choices: Choice<T>[], initial = 0) {
      return new Promise<T | null>((resolve) => {
        let index = Math.min(Math.max(initial, 0), choices.length - 1);
        let drawn = 0;

        const render = () => {
          let text = drawn > 0 ? `\r${up(drawn)}` : "";
          const lines = [
            `${question} (Up and Down to move, Enter to choose)`,
            ...choices.map((choice, i) => {
              const hint = choice.hint ? ` \x1b[2m${choice.hint}\x1b[0m` : "";
              return i === index
                ? `\x1b[36m❯ ${choice.label}\x1b[0m${hint}`
                : `  ${choice.label}${hint}`;
            }),
          ];
          text += lines.map((line) => `${CLEAR_LINE}${line}`).join("\n");
          stderr.write(text);
          drawn = lines.length - 1;
        };

        const finish = (value: T | null) => {
          stdin.off("keypress", onKey);
          stdin.setRawMode(false);
          stdin.pause();
          stderr.write(`\n${SHOW_CURSOR}`);
          resolve(value);
        };

        const onKey = (_text: string, key: readline.Key | undefined) => {
          if (!key) return;
          if ((key.ctrl && key.name === "c") || key.name === "escape") {
            finish(null);
          } else if (key.name === "up" || key.name === "k") {
            index = (index - 1 + choices.length) % choices.length;
            render();
          } else if (key.name === "down" || key.name === "j") {
            index = (index + 1) % choices.length;
            render();
          } else if (key.name === "return" || key.name === "enter") {
            finish(choices[index]!.value);
          }
        };

        readline.emitKeypressEvents(stdin);
        stdin.setRawMode(true);
        stdin.resume();
        stderr.write(HIDE_CURSOR);
        render();
        stdin.on("keypress", onKey);
      });
    },

    input(question: string, defaultValue?: string) {
      return new Promise<string | null>((resolve) => {
        const rl = readline.createInterface({ input: stdin, output: stderr });
        let answered = false;
        const shown = defaultValue ? `${question} (${defaultValue}): ` : `${question}: `;
        rl.on("SIGINT", () => {
          rl.close();
        });
        rl.on("close", () => {
          if (!answered) {
            stderr.write("\n");
            resolve(null);
          }
        });
        rl.question(shown, (answer) => {
          answered = true;
          rl.close();
          const trimmed = answer.trim();
          resolve(trimmed === "" ? defaultValue ?? "" : trimmed);
        });
      });
    },
  };
}
