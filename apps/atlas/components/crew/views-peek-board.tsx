"use client";

import { Board, type RecordState } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useQueryHref } from "./views.shared";

/** A board by state whose cards open the side peek. Cards move only through transitions. */
export function PeekBoard(props: {
  columns: Array<{
    state: RecordState;
    label: string;
    cards: Array<{ key: string; title: string; meta?: string; owner?: string; due?: string }>;
  }>;
}) {
  const router = useRouter();
  const href = useQueryHref();
  return (
    <Board
      readOnly
      columns={props.columns}
      onOpen={(key) => router.push(href({ peek: key, full: null }))}
    />
  );
}
