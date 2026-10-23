import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  LiveProvider,
  useLive,
  type LiveChange,
  type LivePacing,
  type LiveSource,
  type LiveTopic,
} from "../src/index.ts";

function recordingSource() {
  const watches: {
    topics: readonly LiveTopic[];
    pacing: LivePacing | undefined;
    listener: (c: readonly LiveChange[]) => void;
    stopped: boolean;
  }[] = [];
  const source: LiveSource = {
    watch(topics, listener, pacing) {
      const entry = { topics, pacing, listener, stopped: false };
      watches.push(entry);
      return () => {
        entry.stopped = true;
      };
    },
  };
  return { source, watches };
}

function Watcher({
  topics,
  onChange,
  pacing,
}: {
  topics: LiveTopic[] | null;
  onChange: (c: readonly LiveChange[]) => void;
  pacing?: LivePacing;
}) {
  useLive(topics, onChange, pacing);
  return null;
}

describe("useLive", () => {
  it("watches through the provider and stops on unmount", () => {
    const { source, watches } = recordingSource();
    const seen: string[] = [];
    const view = render(
      <LiveProvider source={source}>
        <Watcher
          topics={[{ table: "records", filter: "org_id=eq.o1" }, { table: "shifts" }]}
          onChange={(c) => seen.push(c.map((x) => `${x.type}:${x.id}`).join())}
        />
      </LiveProvider>,
    );
    expect(watches).toHaveLength(1);
    expect(watches[0]?.topics).toEqual([
      { table: "records", filter: "org_id=eq.o1" },
      { table: "shifts" },
    ]);
    watches[0]?.listener([{ table: "records", type: "UPDATE", id: "r1" }]);
    expect(seen).toEqual(["UPDATE:r1"]);
    view.unmount();
    expect(watches[0]?.stopped).toBe(true);
  });

  it("keeps one watch while the same topics rerender, and calls the latest handler", () => {
    const { source, watches } = recordingSource();
    const seen: string[] = [];
    const view = render(
      <LiveProvider source={source}>
        <Watcher topics={[{ table: "records" }]} onChange={() => seen.push("first")} />
      </LiveProvider>,
    );
    view.rerender(
      <LiveProvider source={source}>
        <Watcher topics={[{ table: "records" }]} onChange={() => seen.push("second")} />
      </LiveProvider>,
    );
    expect(watches).toHaveLength(1);
    watches[0]?.listener([{ table: "*", type: "RESYNC", id: null }]);
    expect(seen).toEqual(["second"]);
    view.rerender(
      <LiveProvider source={source}>
        <Watcher
          topics={[{ table: "cues" }]}
          onChange={() => seen.push("third")}
          pacing={{ batchMs: 50, minIntervalMs: 250 }}
        />
      </LiveProvider>,
    );
    expect(watches).toHaveLength(2);
    expect(watches[0]?.stopped).toBe(true);
    expect(watches[1]?.pacing).toEqual({ batchMs: 50, minIntervalMs: 250 });
  });

  it("does nothing without topics or outside a provider", () => {
    const { source, watches } = recordingSource();
    render(
      <LiveProvider source={source}>
        <Watcher topics={null} onChange={() => undefined} />
        <Watcher topics={[]} onChange={() => undefined} />
      </LiveProvider>,
    );
    expect(watches).toHaveLength(0);
    expect(() =>
      render(<Watcher topics={[{ table: "records" }]} onChange={() => undefined} />),
    ).not.toThrow();
  });
});
