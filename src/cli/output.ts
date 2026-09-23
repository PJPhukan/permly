// Terminal output. Colors only when writing to a terminal and NO_COLOR isn't set
// (https://no-color.org: any non-empty value disables color).

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  cyan(text: string): string;
}

export function styleFor(stream: NodeJS.WriteStream): Style {
  const enabled = stream.isTTY === true && !process.env.NO_COLOR;
  const paint = (open: number, close: number) => (text: string) =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  return {
    bold: paint(1, 22),
    dim: paint(2, 22),
    green: paint(32, 39),
    yellow: paint(33, 39),
    red: paint(31, 39),
    cyan: paint(36, 39),
  };
}

export const out = styleFor(process.stdout);
export const err = styleFor(process.stderr);

export function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function printError(message: string): void {
  process.stderr.write(`${err.red("Error:")} ${message}\n`);
}
