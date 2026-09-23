import { createInterface, type Interface } from "node:readline";
import { CancelledError } from "./args";
import { out } from "./output";

/**
 * Line-based prompts. Lines are read through readline's async iterator, which buffers input,
 * so answers piped in all at once (tests, scripts) are not lost between questions.
 */
export class Prompter {
  private readonly rl: Interface;
  private readonly lines: AsyncIterator<string>;

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {
    this.rl = createInterface({ input, output, terminal: process.stdin.isTTY === true });
    this.rl.on("SIGINT", () => {
      this.output.write("\n");
      this.rl.close();
      process.stderr.write("Cancelled.\n");
      process.exit(1);
    });
    this.lines = this.rl[Symbol.asyncIterator]();
  }

  /** Free-text answer; empty input returns `fallback`. */
  async ask(question: string, fallback = ""): Promise<string> {
    const hint = fallback ? ` ${out.dim(`(${fallback})`)}` : "";
    this.output.write(`${out.cyan("?")} ${question}${hint} `);
    const { value, done } = await this.lines.next();
    if (done) {
      this.output.write("\n");
      throw new CancelledError();
    }
    const answer = String(value).trim();
    return answer === "" ? fallback : answer;
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    for (;;) {
      const answer = (
        await this.ask(`${question} ${out.dim(fallback ? "[Y/n]" : "[y/N]")}`)
      ).toLowerCase();
      if (answer === "") return fallback;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      this.output.write(`  Please answer y or n.\n`);
    }
  }

  /** Asks until `parse` accepts the answer; its error message is shown otherwise. */
  async askValid<T>(question: string, fallback: string, parse: (answer: string) => T): Promise<T> {
    for (;;) {
      const answer = await this.ask(question, fallback);
      try {
        return parse(answer);
      } catch (error) {
        this.output.write(
          `  ${out.yellow(error instanceof Error ? error.message : String(error))}\n`,
        );
      }
    }
  }

  close(): void {
    this.rl.close();
  }
}
