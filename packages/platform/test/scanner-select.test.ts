/**
 * Owner decision 10 (ADR 0033): self-hosted ClamAV chosen from XOS_CLAMAV_HOST and XOS_CLAMAV_PORT, a
 * logged pass-through on a local stack only, and no scanner (files stay quarantined) anywhere else.
 * Unit tests stream an EICAR-style file to a fake clamd; the integration test at the end streams it to
 * a real `clamav/clamav:1.5.4` when XOS_CLAMAV_TEST_HOST names one (see infra/scanning/README.md).
 */
import { connect as tcpConnect } from "node:net";
import { describe, expect, it } from "vitest";
import {
  CLAMAV_DEFAULT_PORT,
  ScannerUnavailableError,
  checkContent,
  clamavScanner,
  isLocalDevelopment,
  passThroughScanner,
  runUploadScans,
  scannerChoice,
  selectVirusScanner,
  type ClamdConnection,
  type ScanStore,
  type ClaimedObjectScan,
} from "../src/index.ts";

// The EICAR antivirus test file, assembled at run time so this source file never matches a scanner.
const EICAR = [
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$",
  "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!",
  "$H+H*",
].join("");
const encode = (value: string) => new TextEncoder().encode(value);

const envOf =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

/** A fake clamd that reads INSTREAM chunks and flags the EICAR string, as ClamAV does. */
function fakeClamd() {
  const opened: { host: string; port: number }[] = [];
  const connect = async (host: string, port: number): Promise<ClamdConnection> => {
    opened.push({ host, port });
    const written: number[] = [];
    return {
      async write(bytes) {
        written.push(...bytes);
      },
      async readReply() {
        const all = Uint8Array.from(written);
        const view = new DataView(all.buffer);
        const body: number[] = [];
        for (let at = 10; ;) {
          const length = view.getUint32(at, false);
          at += 4;
          if (length === 0) break;
          body.push(...all.subarray(at, at + length));
          at += length;
        }
        return new TextDecoder().decode(Uint8Array.from(body)).includes(EICAR)
          ? encode("stream: Win.Test.EICAR_HDB-1 FOUND\0")
          : encode("stream: OK\0");
      },
      close() {},
    };
  };
  return { connect, opened };
}

describe("scanner choice", () => {
  it("uses ClamAV at XOS_CLAMAV_HOST, on port 3310 unless XOS_CLAMAV_PORT says otherwise", () => {
    expect(scannerChoice(envOf({ XOS_CLAMAV_HOST: "clamd.internal" }))).toEqual({
      kind: "clamav",
      host: "clamd.internal",
      port: CLAMAV_DEFAULT_PORT,
    });
    expect(
      scannerChoice(envOf({ XOS_CLAMAV_HOST: " 10.0.0.5 ", XOS_CLAMAV_PORT: "13310" })),
    ).toEqual({ kind: "clamav", host: "10.0.0.5", port: 13310 });
  });

  it("refuses a port that is not a TCP port", () => {
    for (const port of ["0", "70000", "clamd", "33.1"]) {
      expect(() =>
        scannerChoice(envOf({ XOS_CLAMAV_HOST: "clamd", XOS_CLAMAV_PORT: port })),
      ).toThrow(/XOS_CLAMAV_PORT/);
    }
  });

  it("passes files through only on a local stack", () => {
    for (const url of [
      "http://kong:8000",
      "http://127.0.0.1:54321",
      "http://localhost:54321",
      "http://[::1]:54321",
      "http://host.docker.internal:54321",
      "http://xos.localhost",
    ]) {
      expect(isLocalDevelopment(envOf({ SUPABASE_URL: url })), url).toBe(true);
      expect(scannerChoice(envOf({ SUPABASE_URL: url })).kind, url).toBe("pass-through");
    }
  });

  it("never passes files through in production or on a hosted project", () => {
    expect(
      scannerChoice(envOf({ SUPABASE_URL: "http://kong:8000", XOS_ENVIRONMENT: "production" })).kind,
    ).toBe("none");
    expect(scannerChoice(envOf({ SUPABASE_URL: "https://abcd.supabase.co" })).kind).toBe("none");
    expect(scannerChoice(envOf({ SUPABASE_URL: "https://api.example.com" })).kind).toBe("none");
    expect(scannerChoice(envOf({ SUPABASE_URL: "not a url" })).kind).toBe("none");
    expect(scannerChoice(envOf({})).kind).toBe("none");
  });

  it("selects the adapter for each choice and logs the pass-through", async () => {
    const clamd = fakeClamd();
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);

    const clamav = selectVirusScanner({
      env: envOf({ XOS_CLAMAV_HOST: "clamd", XOS_CLAMAV_PORT: "3311" }),
      connect: clamd.connect,
      warn,
    });
    expect(clamav.choice.kind).toBe("clamav");
    expect(await clamav.scanner?.scan(encode(EICAR))).toEqual({
      clean: false,
      signature: "Win.Test.EICAR_HDB-1",
    });
    expect(await clamav.scanner?.scan(encode("a,b\n1,2\n"))).toEqual({ clean: true });
    expect(clamd.opened).toEqual([
      { host: "clamd", port: 3311 },
      { host: "clamd", port: 3311 },
    ]);
    expect(warnings).toEqual([]);

    const local = selectVirusScanner({
      env: envOf({ SUPABASE_URL: "http://kong:8000" }),
      connect: clamd.connect,
      warn,
    });
    expect(local.choice.kind).toBe("pass-through");
    expect(await local.scanner?.scan(encode(EICAR))).toEqual({ clean: true });
    expect(warnings[0]).toMatch(/XOS_CLAMAV_HOST is not set on a local stack/);
    expect(warnings[1]).toMatch(/UPLOAD SCAN PASS-THROUGH \(local development only\)/);

    const hosted = selectVirusScanner({
      env: envOf({ SUPABASE_URL: "https://abcd.supabase.co" }),
      connect: clamd.connect,
      warn,
    });
    expect(hosted).toEqual({
      choice: { kind: "none", reason: expect.stringMatching(/stay quarantined/) },
      scanner: null,
    });
    expect(clamd.opened).toHaveLength(2);
  });

  it("warns on every file the pass-through lets through", async () => {
    const warnings: string[] = [];
    const scanner = passThroughScanner((m) => warnings.push(m));
    await scanner.scan(encode("one"));
    await scanner.scan(encode("two"));
    expect(warnings).toHaveLength(2);
  });
});

describe("ClamAV adapter", () => {
  it("counts a clamd that never answers as unavailable and closes the connection", async () => {
    let closes = 0;
    const scanner = clamavScanner({
      timeoutMs: 20,
      connect: async () => ({
        async write() {},
        readReply: () => new Promise<Uint8Array>(() => {}),
        close() {
          closes += 1;
        },
      }),
    });
    await expect(scanner.scan(encode("x"))).rejects.toBeInstanceOf(ScannerUnavailableError);
    expect(closes).toBeGreaterThanOrEqual(1);
  });

  it("rejects an infected import spreadsheet and keeps it out of the worker's clean set", async () => {
    const clamd = fakeClamd();
    const recorded: { id: string; clean: boolean | null; detail: string | null }[] = [];
    const removed: string[] = [];
    const scans: ClaimedObjectScan[] = [
      {
        objectScanId: "s1",
        bucketId: "imports",
        objectName: "p/u1.csv",
        contentType: "text/csv",
        attempts: 1,
      },
      {
        objectScanId: "s2",
        bucketId: "imports",
        objectName: "p/u2.csv",
        contentType: "text/csv",
        attempts: 1,
      },
    ];
    const files: Record<string, Uint8Array> = {
      "p/u1.csv": encode(`name,notes\nAcme,${EICAR}\n`),
      "p/u2.csv": Uint8Array.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a]),
    };
    const store: ScanStore = {
      claimAttachmentScans: async () => [],
      attachmentVersion: async () => null,
      recordAttachmentScan: async () => "Clean",
      finishJob: async () => "Succeeded",
      claimObjectScans: async () => scans,
      recordObjectScan: async (id, clean, detail) => {
        recorded.push({ id, clean, detail });
        return clean === true ? "Clean" : clean === false ? "Infected" : "Scan Failed";
      },
      releaseObjectScan: async () => "Scanning",
    };
    const outcomes = await runUploadScans({
      store,
      storage: {
        download: async (_bucket, name) => files[name] ?? new Uint8Array(),
        remove: async (_bucket, name) => {
          removed.push(name);
        },
      },
      scanner: clamavScanner({ connect: () => clamd.connect("clamd", 3310) }),
      worker: "test",
    });
    expect(outcomes.map((o) => o.result)).toEqual(["infected", "clean"]);
    expect(recorded).toEqual([
      { id: "s1", clean: false, detail: "Win.Test.EICAR_HDB-1" },
      { id: "s2", clean: true, detail: null },
    ]);
    expect(removed).toEqual(["p/u1.csv"]);
  });

  it("accepts a CSV saved in a single-byte encoding such as Windows-1252", () => {
    const cafe = Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x0d, 0x0a]);
    expect(checkContent({ bytes: cafe, contentType: "text/csv", filename: "menu.csv" })).toEqual({
      ok: true,
    });
  });
});

/** A clamd connection over node:net, for the integration test. */
function nodeClamd(host: string, port: number): Promise<ClamdConnection> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port });
    const chunks: Buffer[] = [];
    let ended = false;
    const waiters: (() => void)[] = [];
    const wake = () => waiters.splice(0).forEach((w) => w());
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunk.includes(0)) wake();
    });
    socket.on("end", () => {
      ended = true;
      wake();
    });
    socket.once("error", reject);
    socket.once("connect", () =>
      resolve({
        write: (bytes) =>
          new Promise<void>((done, fail) =>
            socket.write(bytes, (error) => (error ? fail(error) : done())),
          ),
        readReply: () =>
          new Promise<Uint8Array>((done) => {
            const finish = () => done(new Uint8Array(Buffer.concat(chunks)));
            if (ended || Buffer.concat(chunks).includes(0)) finish();
            else waiters.push(finish);
          }),
        close: () => socket.destroy(),
      }),
    );
  });
}

const CLAMD_HOST = process.env["XOS_CLAMAV_TEST_HOST"];
const CLAMD_PORT = Number(process.env["XOS_CLAMAV_TEST_PORT"] ?? CLAMAV_DEFAULT_PORT);

describe.skipIf(CLAMD_HOST === undefined || CLAMD_HOST === "")(
  "ClamAV integration (clamav/clamav:1.5.4)",
  () => {
    const scanner = clamavScanner({
      connect: () => nodeClamd(CLAMD_HOST ?? "", CLAMD_PORT),
      chunkSize: 1024,
    });

    it("finds the EICAR test file", async () => {
      const verdict = await scanner.scan(encode(EICAR));
      expect(verdict.clean).toBe(false);
      expect(verdict.clean ? "" : verdict.signature).toMatch(/eicar/i);
    }, 60_000);

    it("passes an ordinary spreadsheet", async () => {
      const csv = encode(`name,city\n${"Acme Staging,Austin\n".repeat(5000)}`);
      expect(await scanner.scan(csv)).toEqual({ clean: true });
    }, 60_000);
  },
);
