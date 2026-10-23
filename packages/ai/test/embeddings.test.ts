import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingUnavailableError,
  embedTexts,
  embeddingProviderFromEnv,
  GTE_SMALL_MAX_CHARS,
  gteSmallEmbeddings,
  hashEmbedding,
  localHashEmbeddings,
  remoteGteSmallEmbeddings,
  vectorLiteral,
  type EmbeddingProvider,
} from "../src/embeddings.ts";

/** A87 (RRR-132): the embedding seam, Supabase's gte-small as its default, and the local fake. */

function cosine(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
}

describe("hashEmbedding", () => {
  it("is deterministic, unit length and as wide as gte-small", () => {
    const a = hashEmbedding("Wear a harness whenever you climb the truss.");
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(a).toEqual(hashEmbedding("Wear a harness whenever you climb the truss."));
    expect(Math.sqrt(a.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1, 10);
  });

  it("points texts that share word stems the same way and unrelated texts apart", () => {
    const sop = hashEmbedding("Working at height: wear a harness when climbing the truss");
    expect(cosine(sop, hashEmbedding("climbed truss harness"))).toBeGreaterThan(0.4);
    expect(cosine(sop, hashEmbedding("catering invoice for the sponsor lounge"))).toBeLessThan(0.1);
  });

  it("ignores case, accents, punctuation and stop words, and gives zero for no words", () => {
    expect(hashEmbedding("Señal DE Evacuación!")).toEqual(hashEmbedding("senal evacuacion"));
    expect(hashEmbedding("the a of").every((v) => v === 0)).toBe(true);
  });
});

describe("embeddingProviderFromEnv", () => {
  const run = () => Promise.resolve(new Float32Array(384).fill(0.05));

  it("defaults to Supabase's gte-small, in the Edge Runtime or through the Edge Function", () => {
    expect(embeddingProviderFromEnv({}, { gteSmall: run })).toMatchObject({
      provider: "supabase-gte",
      model: "gte-small",
      dimensions: 384,
    });
    expect(
      embeddingProviderFromEnv(
        { XOS_SEARCH_EMBEDDINGS: "  " },
        { remoteGteSmall: () => Promise.resolve([]) },
      )?.model,
    ).toBe("gte-small");
    expect(
      embeddingProviderFromEnv({ XOS_SEARCH_EMBEDDINGS: "supabase-gte" }, { gteSmall: run })?.model,
    ).toBe("gte-small");
  });

  it("returns no provider when it is off or this runtime cannot reach gte-small", () => {
    expect(embeddingProviderFromEnv({})).toBeNull();
    expect(
      embeddingProviderFromEnv({ XOS_SEARCH_EMBEDDINGS: "off" }, { gteSmall: run }),
    ).toBeNull();
  });

  it("runs the local fake only outside production", () => {
    const fake = embeddingProviderFromEnv({
      XOS_SEARCH_EMBEDDINGS: "local-hash",
      NODE_ENV: "test",
    });
    expect(fake?.provider).toBe("local-hash");
    expect(fake?.model).toBe("local-hash-384");
    expect(() =>
      embeddingProviderFromEnv({ XOS_SEARCH_EMBEDDINGS: "local-hash", NODE_ENV: "production" }),
    ).toThrow(EmbeddingUnavailableError);
    expect(() =>
      embeddingProviderFromEnv({
        XOS_SEARCH_EMBEDDINGS: "local-hash",
        XOS_ENVIRONMENT: "production",
      }),
    ).toThrow(EmbeddingUnavailableError);
  });

  it("refuses a provider nobody has chosen", () => {
    expect(() => embeddingProviderFromEnv({ XOS_SEARCH_EMBEDDINGS: "voyage" })).toThrow(
      /owner decision/,
    );
  });
});

describe("embedTexts", () => {
  it("redacts every text before the provider sees it", async () => {
    const seen: string[] = [];
    const provider: EmbeddingProvider = {
      ...localHashEmbeddings(),
      embed(texts) {
        seen.push(...texts);
        return Promise.resolve(texts.map((t) => hashEmbedding(t)));
      },
    };
    const vectors = await embedTexts(
      provider,
      ["Call the stage manager at 305-555-0142 or ops@example.org"],
      "document",
    );
    expect(vectors).toHaveLength(1);
    expect(seen).toEqual(["Call the stage manager at [phone] or [email]"]);
    expect(await embedTexts(provider, [], "query")).toEqual([]);
  });

  it("refuses a provider of another width and malformed answers", async () => {
    const narrow: EmbeddingProvider = { ...localHashEmbeddings(), dimensions: 768 };
    await expect(embedTexts(narrow, ["x"], "query")).rejects.toThrow(/768 dimensions/);
    const short: EmbeddingProvider = {
      ...localHashEmbeddings(),
      embed: (texts) => Promise.resolve(texts.map(() => [1, 2, 3])),
    };
    await expect(embedTexts(short, ["x"], "query")).rejects.toThrow(/malformed/);
    const missing: EmbeddingProvider = {
      ...localHashEmbeddings(),
      embed: () => Promise.resolve([]),
    };
    await expect(embedTexts(missing, ["x"], "query")).rejects.toThrow(/malformed/);
    const nan: EmbeddingProvider = {
      ...localHashEmbeddings(),
      embed: (texts) => Promise.resolve(texts.map(() => new Array(384).fill(Number.NaN))),
    };
    await expect(embedTexts(nan, ["x"], "query")).rejects.toThrow(/malformed/);
  });
});

describe("gte-small adapters", () => {
  it("runs gte-small one text at a time on the start of long text", async () => {
    const seen: string[] = [];
    const provider = gteSmallEmbeddings((text) => {
      seen.push(text);
      return Promise.resolve(new Float32Array(384).fill(0.05));
    });
    const vectors = await embedTexts(provider, ["Working at height", "x".repeat(5000)], "document");
    expect(vectors).toHaveLength(2);
    expect(vectors[0]?.[0]).toBeCloseTo(0.05, 6);
    expect(seen[1]).toHaveLength(GTE_SMALL_MAX_CHARS);
    expect(provider.minSimilarity).toBe(0.82);
  });

  it("asks the Edge Function for a query's vector", async () => {
    const asked: string[] = [];
    const provider = remoteGteSmallEmbeddings((text) => {
      asked.push(text);
      return Promise.resolve(new Array<number>(384).fill(0.1));
    });
    expect(
      await embedTexts(provider, ["call ops@example.org about rigging"], "query"),
    ).toHaveLength(1);
    expect(asked).toEqual(["call [email] about rigging"]);
  });
});

describe("vectorLiteral", () => {
  it("writes pgvector's text form", () => {
    expect(vectorLiteral([0.5, -0.25, 1 / 3, Number.NaN])).toBe("[0.5,-0.25,0.3333333,0]");
  });
});
