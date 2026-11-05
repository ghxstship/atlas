import { act, fireEvent, render, screen } from "@testing-library/react";
import { startTransition, useActionState, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ActionOutcomeScope, useActionOutcome } from "../src/pwa/action-outcome.tsx";

/**
 * Funnel signals from forms that keep their server action (A146, ADR 0052): a form that stays sees its own result, and
 * a row that leaves with its result is covered by the scope that stays.
 */

interface Result {
  readonly ok?: boolean;
}

function deferred() {
  let resolve: (value: Result) => void = () => undefined;
  const promise = new Promise<Result>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function Row({
  name,
  run,
  onSuccess,
}: {
  name: string;
  run: () => Promise<Result>;
  onSuccess: () => void;
}) {
  const [state, dispatch, pending] = useActionState<Result, null>(() => run(), {});
  useActionOutcome(state, pending, (s) => s.ok === true, onSuccess);
  return (
    <button type="button" onClick={() => startTransition(() => dispatch(null))}>
      {name}
    </button>
  );
}

/** A queue whose rows leave once their action succeeds, in the same commit as the result. */
function Queue({
  scoped,
  onSuccess,
  refuse = false,
}: {
  scoped: boolean;
  onSuccess: () => void;
  refuse?: boolean;
}) {
  const [rows, setRows] = useState(["first", "second"]);
  const list = rows.map((name) => (
    <Row
      key={name}
      name={name}
      onSuccess={onSuccess}
      run={async () => {
        await Promise.resolve();
        if (refuse) return { ok: false };
        setRows((current) => current.filter((r) => r !== name));
        return { ok: true };
      }}
    />
  ));
  return scoped ? (
    <ActionOutcomeScope token={rows.join(",")}>{list}</ActionOutcomeScope>
  ) : (
    <>{list}</>
  );
}

describe("action outcomes", () => {
  it("calls back once for each success of a form that stays", async () => {
    const onSuccess = vi.fn();
    const results: Result[] = [{ ok: true }, { ok: false }, { ok: true }];
    render(<Row name="save" run={async () => results.shift() ?? {}} onSuccess={onSuccess} />);
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "save" }));
      });
    }
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });

  it("calls back for a row that leaves with its result inside a scope", async () => {
    const onSuccess = vi.fn();
    render(<Queue scoped onSuccess={onSuccess} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "first" }));
    });
    expect(screen.queryByRole("button", { name: "first" })).toBeNull();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("misses a row that leaves with its result outside a scope", async () => {
    const onSuccess = vi.fn();
    render(<Queue scoped={false} onSuccess={onSuccess} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "first" }));
    });
    expect(screen.queryByRole("button", { name: "first" })).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("never calls back for a refused action", async () => {
    const onSuccess = vi.fn();
    render(<Queue scoped refuse onSuccess={onSuccess} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "first" }));
    });
    expect(screen.getByRole("button", { name: "first" })).toBeDefined();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("never calls back for a row that leaves while pending when the token stays", async () => {
    const onSuccess = vi.fn();
    const pending = deferred();
    function Page() {
      const [shown, setShown] = useState(true);
      return (
        <ActionOutcomeScope token="same">
          {shown ? <Row name="send" run={() => pending.promise} onSuccess={onSuccess} /> : null}
          <button type="button" onClick={() => setShown(false)}>
            hide
          </button>
        </ActionOutcomeScope>
      );
    }
    render(<Page />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "hide" }));
    });
    await act(async () => {
      pending.resolve({ ok: true });
      await pending.promise;
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
