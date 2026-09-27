// Terminal colour, applied only when the output is styled (see Output).
// Plain text otherwise, so logs and pipes never see escape codes.

import type { Output } from "./output.ts";

const paint = (code: number) => (output: Output, text: string) =>
  output.styled ? `\x1b[${code}m${text}\x1b[0m` : text;

export const green = paint(32);
export const red = paint(31);
export const yellow = paint(33);
export const bold = paint(1);
export const dim = paint(2);

/** A success line: a green tick and message. */
export const success = (output: Output, text: string) => green(output, `✓ ${text}`);

/** A failure line: a red cross and message. */
export const failure = (output: Output, text: string) => red(output, `✗ ${text}`);
