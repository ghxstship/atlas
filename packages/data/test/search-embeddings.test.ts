import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  restAppRpc,
  runSearchEmbeddings,
  searchEmbeddingStore,
  supabaseSearchEmbeddingStore,
  toVectorLiteral,
  type SearchEmbedder,
  type SearchEmbeddingSource,
  type SearchEmbeddingStore,
} from "../src/search-embeddings.ts";

/** A87 (RRR-132): the semantic search embedding worker. */

function source(id: string, content = `text of ${id}`): SearchEmbeddingSource {
  return { orgId: "o1", sourceTable: "sops", sourceId: id, content, contentSha256: "a".repeat(64) };
}

function memoryStore(backlog: SearchEmbeddingSource[][], staleIds: readonly string[] = []) {
  const stored: { id: string; provider: string; model: string; width: number }[] = [];
  const asked: { provider: string; model: string; limit: number }[] = [];
  const store: SearchEmbeddingStore = {
    retire: () => Promise.resolve(2),
    backlog(provider, model, limit) {
      asked.push({ provider, model, limit });
      return Promise.resolve(backlog.shift() ?? []);
    },
    store(s, provider, model, vector) {
      if (staleIds.includes(s.sourceId)) return Promise.resolve("stale");
      stored.push({ id: s.sourceId, provider, model, width: vector.length });
      return Promise.resolve("stored");
    },
  };
  return { store, stored, asked };
}

const embedder: SearchEmbedder = {
  provider: "local-hash",
  model: "local-hash-384",
  embed: (texts) => Promise.resolve(texts.map(() => new Array<number>(384).fill(0.03125))),
};

describe("runSearchEmbeddings", () => {
  it("only retires when no provider is configured", async () => {
    const { store, asked } = memoryStore([[source("s1")]]);
    expect(await runSearchEmbeddings({ store, embedder: null })).toEqual({
      retired: 2,
      embedded: 0,
      stale: 0,
      error: null,
    });
    expect(asked).toEqual([]);
  });

  it("embeds the backlog in batches and stores each vector", async () => {
    const { store, stored, asked } = memoryStore([[source("s1"), source("s2")], [source("s3")]]);
    const seen: string[][] = [];
    const pass = await runSearchEmbeddings({
      store,
      embedder: { ...embedder, embed: (t) => (seen.push([...t]), embedder.embed(t)) },
      batch: 2,
    });
    expect(pass).toEqual({ retired: 2, embedded: 3, stale: 0, error: null });
    expect(stored.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(stored.every((s) => s.width === 384 && s.model === "local-hash-384")).toBe(true);
    expect(seen).toEqual([["text of s1", "text of s2"], ["text of s3"]]);
    expect(asked[0]).toEqual({ provider: "local-hash", model: "local-hash-384", limit: 2 });
  });

  it("counts sources that changed meanwhile and stops rather than loop on them", async () => {
    const { store } = memoryStore(
      [
        [source("s1"), source("s2")],
        [source("s1"), source("s2")],
      ],
      ["s1", "s2"],
    );
    expect(await runSearchEmbeddings({ store, embedder, batch: 2, batches: 5 })).toEqual({
      retired: 2,
      embedded: 0,
      stale: 2,
      error: null,
    });
  });

  it("stops with the provider's error and keeps what it stored", async () => {
    const { store } = memoryStore([[source("s1")]]);
    const failing: SearchEmbedder = {
      ...embedder,
      embed: () => Promise.reject(new Error("provider down")),
    };
    expect(await runSearchEmbeddings({ store, embedder: failing })).toEqual({
      retired: 2,
      embedded: 0,
      stale: 0,
      error: "provider down",
    });
    const odd: SearchEmbedder = { ...embedder, embed: () => Promise.reject("no") };
    expect(
      (await runSearchEmbeddings({ store: memoryStore([[source("s1")]]).store, embedder: odd }))
        .error,
    ).toBe("no");
  });

  it("skips a source the provider returned no vector for", async () => {
    const { store, stored } = memoryStore([[source("s1"), source("s2")]]);
    const partial: SearchEmbedder = {
      ...embedder,
      embed: () => Promise.resolve([new Array(384).fill(0)]),
    };
    await runSearchEmbeddings({ store, embedder: partial, batch: 2 });
    expect(stored.map((s) => s.id)).toEqual(["s1"]);
  });
});

describe("toVectorLiteral", () => {
  it("writes pgvector's text form", () => {
    expect(toVectorLiteral([0.5, 1 / 3, Number.POSITIVE_INFINITY])).toBe("[0.5,0.3333333,0]");
  });
});

describe("supabaseSearchEmbeddingStore", () => {
  function client(
    answers: Record<string, { data: unknown; error: { message: string; hint?: string } | null }[]>,
  ) {
    const calls: { fn: string; args: unknown }[] = [];
    const fake = {
      schema: () => ({
        rpc(fn: string, args?: unknown) {
          calls.push({ fn, args });
          const answer = answers[fn]?.shift();
          if (!answer) throw new Error(`no answer for ${fn}`);
          return Promise.resolve(answer);
        },
      }),
    };
    return { store: supabaseSearchEmbeddingStore(fake as unknown as SupabaseClient), calls };
  }

  it("calls the worker RPCs and maps their rows", async () => {
    const row = {
      org_id: "o1",
      source_table: "sops",
      source_id: "s1",
      content: "Working at Height",
      content_sha256: "b".repeat(64),
    };
    const { store, calls } = client({
      retire_search_embeddings: [{ data: 3, error: null }],
      search_embedding_backlog: [{ data: [row, { ...row, source_table: "people" }], error: null }],
      store_search_embedding: [
        { data: "e1", error: null },
        {
          data: null,
          error: { message: "search_source_changed: changed", hint: "search_source_changed" },
        },
        { data: null, error: { message: "boom" } },
      ],
    });
    expect(await store.retire()).toBe(3);
    const backlog = await store.backlog("local-hash", "local-hash-384", 8);
    expect(backlog).toEqual([
      {
        orgId: "o1",
        sourceTable: "sops",
        sourceId: "s1",
        content: "Working at Height",
        contentSha256: "b".repeat(64),
      },
    ]);
    const first = backlog[0] as SearchEmbeddingSource;
    expect(await store.store(first, "local-hash", "local-hash-384", [0.5, 0.25])).toBe("stored");
    expect(await store.store(first, "local-hash", "local-hash-384", [0.5])).toBe("stale");
    await expect(store.store(first, "local-hash", "local-hash-384", [0.5])).rejects.toThrow(/boom/);
    expect(calls[1]).toEqual({
      fn: "search_embedding_backlog",
      args: { p_provider: "local-hash", p_model: "local-hash-384", p_limit: 8 },
    });
    expect(calls[2]?.args).toMatchObject({ p_source_id: "s1", p_embedding: "[0.5,0.25]" });
  });

  it("throws on a failed read and on a row without its fields", async () => {
    const { store } = client({
      retire_search_embeddings: [{ data: null, error: { message: "down" } }],
      search_embedding_backlog: [
        { data: null, error: { message: "down" } },
        { data: [{ source_table: "sops" }], error: null },
      ],
    });
    await expect(store.retire()).rejects.toThrow(/down/);
    await expect(store.backlog("p", "m", 1)).rejects.toThrow(/down/);
    await expect(store.backlog("p", "m", 1)).rejects.toThrow(/lacks org_id/);
  });
});

describe("restAppRpc", () => {
  it("calls an app RPC over PostgREST and maps errors as supabase-js does", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const answers = [
      new Response("3", { status: 200 }),
      new Response(null, { status: 204 }),
      new Response(
        JSON.stringify({
          message: "search_source_changed: changed",
          hint: "search_source_changed",
        }),
        { status: 400 },
      ),
      new Response("{}", { status: 500 }),
    ];
    const rpc = restAppRpc({
      url: "http://127.0.0.1:62121",
      apiKey: "anon-key",
      authorization: "Bearer service-key",
      fetch: (input, init) => {
        seen.push({ url: String(input), init: init ?? {} });
        return Promise.resolve(answers.shift() as Response);
      },
    });
    expect(await rpc("retire_search_embeddings")).toEqual({ data: 3, error: null });
    expect(await rpc("store_search_embedding", { p_source_id: "s1" })).toEqual({
      data: null,
      error: null,
    });
    expect(await rpc("store_search_embedding")).toEqual({
      data: null,
      error: { message: "search_source_changed: changed", hint: "search_source_changed" },
    });
    expect(await rpc("search_context")).toEqual({
      data: null,
      error: { message: "HTTP 500", hint: null },
    });
    expect(seen[0]?.url).toBe("http://127.0.0.1:62121/rest/v1/rpc/retire_search_embeddings");
    expect(seen[1]?.init.headers).toMatchObject({
      apikey: "anon-key",
      Authorization: "Bearer service-key",
      "Content-Profile": "app",
      "Accept-Profile": "app",
    });
    expect(seen[1]?.init.body).toBe('{"p_source_id":"s1"}');
  });

  it("drives the store", async () => {
    const store = searchEmbeddingStore(() => Promise.resolve({ data: 4, error: null }));
    expect(await store.retire()).toBe(4);
  });
});
