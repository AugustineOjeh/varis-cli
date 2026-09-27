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
};

export const processOutput: Output = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};
