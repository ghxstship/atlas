import { describe, expect, it } from "vitest";
import { uploadGlossary } from "../../src/translation/glossary-upload.ts";
import {
  GoogleError,
  adcTokenSource,
  googleTransport,
  requireEnv,
} from "../../src/translation/transport.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch that answers from a script of responses and records every request. No network. */
function scriptedFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = responses.shift() ?? { status: 500, body: { error: "script ran out" } };
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status,
    });
  };
  return { calls, fetch: fn as typeof fetch };
}

const base = {
  project: "xos-translate-123456",
  location: "us-central1",
  model: "general/translation-llm",
  sourceLanguage: "en",
  glossaryId: "xos-glossary-1a2b3c4d",
  contextualGlossary: true,
  sleep: async () => undefined,
};

describe("googleTransport", () => {
  it("calls translateText with HTML, the model and the glossary, and reads glossaryTranslations", async () => {
    const { calls, fetch } = scriptedFetch([
      {
        status: 200,
        body: {
          glossaryTranslations: [{ translatedText: "Guardar" }, { translatedText: "Cancelar" }],
        },
      },
    ]);
    const transport = googleTransport({ ...base, token: async () => "abc", fetch });
    expect(
      await transport.translate({ contents: ["Save", "Cancel"], target: "es-US", glossary: true }),
    ).toEqual(["Guardar", "Cancelar"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://translation.googleapis.com/v3/projects/xos-translate-123456/locations/us-central1:translateText",
    );
    expect(calls[0]?.headers).toMatchObject({
      authorization: "Bearer abc",
      "x-goog-user-project": "xos-translate-123456",
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      contents: ["Save", "Cancel"],
      mimeType: "text/html",
      sourceLanguageCode: "en",
      targetLanguageCode: "es-US",
      model: "projects/xos-translate-123456/locations/us-central1/models/general/translation-llm",
      labels: { tool: "xos-i18n" },
      glossaryConfig: {
        glossary:
          "projects/xos-translate-123456/locations/us-central1/glossaries/xos-glossary-1a2b3c4d",
        ignoreCase: false,
        contextualTranslationEnabled: true,
      },
    });
  });

  it("leaves the glossary out when a batch does not use it", async () => {
    const { calls, fetch } = scriptedFetch([
      { status: 200, body: { translations: [{ translatedText: "Puerta" }] } },
    ]);
    const transport = googleTransport({ ...base, token: async () => "t", fetch });
    expect(
      await transport.translate({ contents: ["Gate"], target: "es-US", glossary: false }),
    ).toEqual(["Puerta"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).not.toHaveProperty("glossaryConfig");
  });

  it("retries rate limits and server errors, refreshes the token once on 401, and gives up on 400", async () => {
    const tokens: boolean[] = [];
    const token = async (refresh?: boolean) => {
      tokens.push(refresh === true);
      return "t";
    };
    const { calls, fetch } = scriptedFetch([
      { status: 401, body: "expired" },
      { status: 429, body: "slow down" },
      { status: 503, body: "unavailable" },
      { status: 200, body: { translations: [{ translatedText: "Hola" }] } },
    ]);
    expect(
      await googleTransport({ ...base, token, fetch }).translate({
        contents: ["Hello"],
        target: "es-US",
        glossary: false,
      }),
    ).toEqual(["Hola"]);
    expect(calls).toHaveLength(4);
    expect(tokens).toEqual([false, true, true, true]);
    const failing = scriptedFetch([{ status: 400, body: "glossary not found" }]);
    await expect(
      googleTransport({ ...base, token, fetch: failing.fetch }).translate({
        contents: ["x"],
        target: "es-US",
        glossary: true,
      }),
    ).rejects.toThrow(GoogleError);
  });

  it("refuses a reply with the wrong number of translations", async () => {
    const { fetch } = scriptedFetch([{ status: 200, body: { translations: [] } }]);
    await expect(
      googleTransport({ ...base, token: async () => "t", fetch }).translate({
        contents: ["x"],
        target: "es-US",
        glossary: false,
      }),
    ).rejects.toThrow("0 translations for 1");
  });
});

describe("Application Default Credentials", () => {
  it("prefers GOOGLE_OAUTH_ACCESS_TOKEN, then asks gcloud, and caches the answer", async () => {
    expect(await adcTokenSource({ GOOGLE_OAUTH_ACCESS_TOKEN: "from-ci" }, () => "unused")()).toBe(
      "from-ci",
    );
    const runs: string[] = [];
    const source = adcTokenSource({}, (cmd, args) => {
      runs.push([cmd, ...args].join(" "));
      return "from-gcloud\n";
    });
    expect(await source()).toBe("from-gcloud");
    expect(await source()).toBe("from-gcloud");
    expect(await source(true)).toBe("from-gcloud");
    expect(runs).toEqual([
      "gcloud auth application-default print-access-token",
      "gcloud auth application-default print-access-token",
    ]);
  });

  it("explains how to log in when gcloud has no credentials", async () => {
    const source = adcTokenSource({}, () => {
      throw new Error("not logged in");
    });
    await expect(source()).rejects.toThrow("gcloud auth application-default login");
    expect(() => requireEnv({}, "GOOGLE_CLOUD_PROJECT", "xos-translate-123456")).toThrow(
      "Set GOOGLE_CLOUD_PROJECT (for example xos-translate-123456)",
    );
  });
});

describe("uploadGlossary", () => {
  const upload = {
    ...base,
    bucket: "xos-translate-123456-glossaries",
    csv: "en,es-US\ngate,compuerta\n",
    languages: ["en", "es-US"],
    token: async () => "t",
  };

  it("does nothing when the glossary version already exists", async () => {
    const { calls, fetch } = scriptedFetch([{ status: 200, body: { name: "x" } }]);
    const log: string[] = [];
    expect(await uploadGlossary({ ...upload, fetch, log: (l) => log.push(l) })).toBe("exists");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("copies the CSV to Cloud Storage, creates the glossary and waits for the operation", async () => {
    const { calls, fetch } = scriptedFetch([
      { status: 404, body: { error: { code: 404 } } },
      { status: 200, body: { name: "glossaries/xos-glossary-1a2b3c4d.csv" } },
      {
        status: 200,
        body: { name: "projects/p/locations/us-central1/operations/op-1", done: false },
      },
      {
        status: 200,
        body: { name: "projects/p/locations/us-central1/operations/op-1", done: true },
      },
    ]);
    expect(await uploadGlossary({ ...upload, fetch, log: () => undefined })).toBe("created");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://translation.googleapis.com/v3/projects/xos-translate-123456/locations/us-central1/glossaries/xos-glossary-1a2b3c4d",
      "POST https://storage.googleapis.com/upload/storage/v1/b/xos-translate-123456-glossaries/o?uploadType=media&name=glossaries%2Fxos-glossary-1a2b3c4d.csv",
      "POST https://translation.googleapis.com/v3/projects/xos-translate-123456/locations/us-central1/glossaries",
      "GET https://translation.googleapis.com/v3/projects/p/locations/us-central1/operations/op-1",
    ]);
    expect(calls[1]?.body).toBe(upload.csv);
    expect(JSON.parse(calls[2]?.body ?? "{}")).toEqual({
      name: "projects/xos-translate-123456/locations/us-central1/glossaries/xos-glossary-1a2b3c4d",
      languageCodesSet: { languageCodes: ["en", "es-US"] },
      inputConfig: {
        gcsSource: {
          inputUri: "gs://xos-translate-123456-glossaries/glossaries/xos-glossary-1a2b3c4d.csv",
        },
      },
    });
  });
});
