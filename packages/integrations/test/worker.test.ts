import { describe, expect, it } from "vitest";
import { integrationsTranslator } from "../src/framework/messages.ts";
import {
  allConnectors,
  runIntegrationWorker,
  unwiredProviders,
  type WorkerDeps,
} from "../src/worker.ts";
import { okData, recordingDb, scriptedHttp } from "./doubles.ts";

function deps(queues: Parameters<typeof recordingDb>[0] = {}): WorkerDeps {
  return {
    db: recordingDb(queues).db,
    canon: recordingDb({}).db,
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        download: async () => ({ data: new Blob([""]), error: null }),
      }),
    },
    http: scriptedHttp([]).http,
    resolve: async () => ["93.184.216.34"],
    translate: integrationsTranslator("en-US"),
  };
}

describe("integration worker", () => {
  it("wires a connector for every provider in the catalog", () => {
    const connectors = allConnectors(deps());
    expect(connectors).toHaveLength(19);
    expect(unwiredProviders(connectors)).toEqual([]);
    expect(unwiredProviders(connectors.slice(1))).toEqual(["xero"]);
  });

  it("claims integration.sync jobs from the job queue", async () => {
    const outcomes = await runIntegrationWorker(
      deps({ "rpc:claim_jobs": [okData([])] }),
      "worker-1",
      5,
    );
    expect(outcomes).toEqual([]);
  });
});
