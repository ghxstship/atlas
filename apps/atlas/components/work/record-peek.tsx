"use client";

import { SidePeek, type RecordKind } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useCopy } from "./action-ui";
import { stateToken, withQuery } from "./format";

/**
 * The record side peek (`?peek={recordKey}` on any route, Section 4.5.3). Closing removes the
 * parameter; Open full goes to `/{org}/r/{recordKey}`. Below md the peek opens full screen.
 */
export function RecordPeek({
  org,
  recordKey,
  kind,
  title,
  state,
  properties,
  children,
}: {
  org: string;
  recordKey: string;
  kind: string;
  title: string;
  state: string;
  properties: { label: string; value: ReactNode }[];
  children: ReactNode;
}) {
  const t = useCopy("work");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const fullHref = `/${org}/r/${recordKey}`;
  return (
    <SidePeek
      open
      onOpenChange={(open) => {
        if (!open)
          router.replace(withQuery(pathname, params, { peek: null }) as Route, { scroll: false });
      }}
      recordKey={recordKey}
      kind={kind as RecordKind}
      title={title}
      state={stateToken(state)}
      stateLabel={t(`states.${state}`)}
      properties={properties}
      onOpenFull={() => router.push(fullHref as Route)}
      onCopyLink={() => {
        void navigator.clipboard.writeText(`${window.location.origin}${fullHref}`);
      }}
    >
      {children}
    </SidePeek>
  );
}
