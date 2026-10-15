"use client";

import type { BoardProps } from "@xos/ui";
import { InlineAlert } from "@xos/ui";
import { useState } from "react";
import { movePermitAction } from "@/app/[org]/safety/actions";
import { PeekBoard } from "@/components/places/kit/client";
import { useCopy } from "@/components/places/kit/form";

/**
 * Tracked permits by record state. Dragging a card (or Space, the arrow keys and Space again) asks
 * the record lifecycle for the move; a move it does not allow is refused with its reason and the
 * card returns to its column when the page refreshes.
 */
export function PermitBoard({
  org,
  columns,
  recordOf,
  stateOf,
}: {
  org: string;
  columns: BoardProps["columns"];
  /** Requirement id (the card key) to its Permit record id. */
  recordOf: Readonly<Record<string, string>>;
  /** Board state token to canon record state ("in-review" to "In Review"). */
  stateOf: Readonly<Record<string, string>>;
}) {
  const t = useCopy("permits");
  const errors = useCopy("places");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-8">
      {error ? (
        <InlineAlert tone="danger" title={errors("errors.title")}>
          {errors(`errors.${error}`)}
        </InlineAlert>
      ) : null}
      <PeekBoard
        columns={columns}
        onMoveAction={async (key, from, to) => {
          const recordId = recordOf[key];
          const fromState = stateOf[from];
          const toState = stateOf[to];
          if (!recordId || !fromState || !toState) return;
          const result = await movePermitAction(
            org,
            recordId,
            fromState,
            toState,
            t("permits.boardReason"),
          );
          setError(result.error ?? null);
        }}
      />
    </div>
  );
}
