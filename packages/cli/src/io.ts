/** The process boundary, injected so every command is testable without a real terminal. */

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Reads all of standard input. */
  readonly readStdin: () => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether stdout is an interactive terminal; selects table output by default. */
  readonly isTTY: boolean;
  /** Replaces `fetch` for the API client and webhook test deliveries. */
  readonly fetch?: typeof fetch;
  /** Waits between retries; replaceable in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A mistake in how the command was invoked. Exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  refused: 5,
} as const;

export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}
