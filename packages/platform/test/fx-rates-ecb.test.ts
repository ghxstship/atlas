import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ECB_DAILY_URL,
  EcbParseError,
  parseEcbDaily,
  runEcbFeed,
  type EcbDaily,
  type FxFeedStore,
} from "../../../supabase/functions/fx-rates-ecb/ecb.ts";

/**
 * The ECB reference rate worker (Section 15, ADR 0053), on a committed copy of the daily file's format. No test
 * here touches the network: the fetch is scripted.
 */

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/eurofxref-daily.xml", import.meta.url)),
  "utf8",
);

function recordingStore(refuse?: string) {
  const recorded: Array<{ source: string; daily: EcbDaily }> = [];
  const failed: Array<{ source: string; error: string }> = [];
  const store: FxFeedStore = {
    async record(source, daily) {
      if (refuse) throw new Error(refuse);
      recorded.push({ source, daily });
      return { inserted: Object.keys(daily.rates).length };
    },
    async fail(source, error) {
      failed.push({ source, error });
    },
  };
  return { store, recorded, failed };
}

const answer = (body: string, status = 200): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("parsing the daily file", () => {
  it("reads the ECB publication date and every currency per euro", () => {
    const daily = parseEcbDaily(FIXTURE);
    expect(daily.date).toBe("2026-10-20");
    expect(Object.keys(daily.rates)).toHaveLength(29);
    expect(daily.rates["USD"]).toBe(1.0893);
    expect(daily.rates["JPY"]).toBe(162.41);
    expect(daily.rates["EUR"]).toBeUndefined();
  });

  it("refuses what is not one day's reference rates", () => {
    expect(() => parseEcbDaily("<html>Service unavailable</html>")).toThrow(EcbParseError);
    const twoDays = FIXTURE.replace(
      "<Cube time='2026-10-20'>",
      "<Cube time='2026-10-19'></Cube><Cube time='2026-10-20'>",
    );
    expect(() => parseEcbDaily(twoDays)).toThrow(/one rate date, found 2/);
    expect(() => parseEcbDaily(FIXTURE.replace("2026-10-20", "2026-02-30"))).toThrow(
      /not a calendar date/,
    );
    const noRates = FIXTURE.replace(/<Cube currency=[^>]+\/>/g, "");
    expect(() => parseEcbDaily(noRates)).toThrow(/no rates/);
  });

  it("skips a rate that is not a positive number", () => {
    const odd = FIXTURE.replace("rate='1.0893'", "rate='0'").replace(
      "<Cube currency='JPY' rate='162.41'/>",
      "<Cube currency='JPY' rate='162.41'/><Cube currency='EUR' rate='1'/>",
    );
    const daily = parseEcbDaily(odd);
    expect(daily.rates["USD"]).toBeUndefined();
    expect(daily.rates["EUR"]).toBeUndefined();
    expect(Object.keys(daily.rates)).toHaveLength(28);
  });
});

describe("running the feed", () => {
  it("records the day's rates from the ECB's daily file", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return new Response(FIXTURE, { status: 200 });
    }) as unknown as typeof fetch;
    const { store, recorded, failed } = recordingStore();
    const outcome = await runEcbFeed({ fetch: fetcher, store });
    expect(urls).toEqual([ECB_DAILY_URL]);
    expect(outcome).toMatchObject({ ok: true, date: "2026-10-20", currencies: 29 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.source).toBe("ECB");
    expect(failed).toEqual([]);
  });

  it("records a failure for an HTTP error, a broken file or a refusing database, never dropping it", async () => {
    const http = recordingStore();
    expect(await runEcbFeed({ fetch: answer("", 503), store: http.store })).toEqual({
      ok: false,
      error: "fetch: The ECB answered HTTP 503.",
    });
    expect(http.failed).toEqual([{ source: "ECB", error: "fetch: The ECB answered HTTP 503." }]);

    const broken = recordingStore();
    const parsed = await runEcbFeed({ fetch: answer("<html/>"), store: broken.store });
    expect(parsed.ok).toBe(false);
    expect(broken.failed[0]?.error).toMatch(/^parse: /);

    const refused = recordingStore("permission denied for function record_fx_reference_rates");
    const recorded = await runEcbFeed({ fetch: answer(FIXTURE), store: refused.store });
    expect(recorded.ok).toBe(false);
    expect(refused.failed[0]?.error).toBe(
      "record: permission denied for function record_fx_reference_rates",
    );

    const offline = recordingStore();
    const thrown = (async () => {
      throw new TypeError("network unreachable");
    }) as unknown as typeof fetch;
    expect((await runEcbFeed({ fetch: thrown, store: offline.store })).ok).toBe(false);
    expect(offline.failed[0]?.error).toBe("fetch: network unreachable");
  });

  it("says when even the failure could not be recorded", async () => {
    const store: FxFeedStore = {
      record: async () => undefined,
      fail: async () => {
        throw new Error("database unreachable");
      },
    };
    const outcome = await runEcbFeed({ fetch: answer("", 500), store });
    expect(outcome).toEqual({
      ok: false,
      error:
        "fetch: The ECB answered HTTP 500. (and the failure could not be recorded: database unreachable)",
    });
  });
});
