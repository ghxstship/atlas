import { ScannerUnavailableError, type ScanVerdict, type VirusScanner } from "./scanner.ts";

/**
 * ClamAV adapter: streams a file to clamd over TCP with the INSTREAM command and reads its verdict.
 * The TCP connection is injected, so the same adapter runs on Deno (`Deno.connect`, in the
 * upload-scan Edge Function) and on Node. infra/scanning/docker-compose.yaml runs clamd locally.
 *
 * Protocol (clamd(8)): send `zINSTREAM\0`, then chunks each prefixed with its length as a 4-byte
 * big-endian integer, then a zero-length chunk. clamd answers `stream: OK`, `stream: <name> FOUND`
 * or `<message> ERROR`, terminated by a NUL byte.
 */
export interface ClamdConnection {
  write(bytes: Uint8Array): Promise<void>;
  /** Reads until clamd closes the connection or sends the terminating NUL byte. */
  readReply(): Promise<Uint8Array>;
  /** Closes the connection; may be called more than once (a timeout closes it early). */
  close(): void;
}

export type ClamdConnect = () => Promise<ClamdConnection>;

export interface ClamavOptions {
  readonly connect: ClamdConnect;
  /** Bytes per INSTREAM chunk; clamd's StreamMaxLength still bounds the whole stream. */
  readonly chunkSize?: number;
  /** Milliseconds one scan may take before clamd counts as unavailable (default 60 s). */
  readonly timeoutMs?: number;
}

const COMMAND = new TextEncoder().encode("zINSTREAM\0");

function lengthPrefix(length: number): Uint8Array {
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, length, false);
  return prefix;
}

/** Reads clamd's reply into a verdict. Anything that is not OK or FOUND is not a verdict. */
export function parseClamdReply(reply: string): ScanVerdict {
  const text = reply.replace(/\0+$/, "").trim();
  if (text.endsWith(": OK")) return { clean: true };
  const found = /^.*?:\s+(.+)\s+FOUND$/.exec(text);
  if (found !== null) return { clean: false, signature: (found[1] ?? "").slice(0, 200) };
  throw new ScannerUnavailableError(`clamd gave no verdict: ${text.slice(0, 200)}`);
}

/** Rejects after `ms`, so a clamd that stops answering cannot hold a worker for ever. */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new ScannerUnavailableError(`clamd did not answer within ${ms} ms`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function clamavScanner(options: ClamavOptions): VirusScanner {
  const chunkSize = options.chunkSize ?? 64 * 1024;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return {
    scan(bytes) {
      let open: ClamdConnection | undefined;
      return withTimeout(
        scanOnce(bytes, (connection) => {
          open = connection;
        }),
        timeoutMs,
        () => open?.close(),
      );
    },
  };

  async function scanOnce(
    bytes: Uint8Array,
    opened: (connection: ClamdConnection) => void,
  ): Promise<ScanVerdict> {
    let connection: ClamdConnection;
    try {
      connection = await options.connect();
    } catch (error) {
      throw new ScannerUnavailableError("clamd is unreachable", { cause: error });
    }
    opened(connection);
    try {
      await connection.write(COMMAND);
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        await connection.write(lengthPrefix(chunk.length));
        await connection.write(chunk);
      }
      await connection.write(lengthPrefix(0));
      const reply = new TextDecoder().decode(await connection.readReply());
      return parseClamdReply(reply);
    } catch (error) {
      if (error instanceof ScannerUnavailableError) throw error;
      throw new ScannerUnavailableError("clamd stopped answering", { cause: error });
    } finally {
      connection.close();
    }
  }
}
