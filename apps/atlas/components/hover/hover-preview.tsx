"use client";

import type { PersonCard } from "@xos/data/person-card";
import { Avatar, HoverCard, StateChip } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useState, type CSSProperties } from "react";
import { personCardAction, recordCardAction } from "@/lib/hover/actions";
import type { HoverInfo, RecordPreview } from "./use-hover-cards";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Cards fetched this session, so moving back over a name or a key never refetches it. */
const people = new Map<string, Promise<PersonCard | null>>();
const records = new Map<string, Promise<RecordPreview | null>>();

function cached<T>(
  cache: Map<string, Promise<T | null>>,
  key: string,
  load: () => Promise<T | null>,
) {
  let card = cache.get(key);
  if (!card) {
    card = load().catch(() => null);
    cache.set(key, card);
  }
  return card;
}

/** A card read on demand: undefined while it loads, null when it cannot be shown. */
function useLoaded<T>(load: () => Promise<T | null>, key: string): T | null | undefined {
  const [card, setCard] = useState<{ key: string; value: T | null } | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((value) => {
      if (live) setCard({ key, value });
    });
    return () => {
      live = false;
    };
    // The key names what `load` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return card?.key === key ? card.value : undefined;
}

/** The space a card needs below its part before it opens above instead. */
const ROOM_BELOW = 220;

const panelClass =
  "flex w-(--ui-hovercard) flex-col gap-6 rounded-card bg-bg-raised p-12 text-text-13 text-text-primary shadow-menu forced-colors:border";

/**
 * A hover card beside its part (Section 11.7), loaded on demand by useHoverCards: a record's title,
 * state, owner and next date (read by its key when the page has only the key), or a person's role,
 * membership and open records. It never takes focus; the part, or the focused row, is described by
 * it while it shows.
 */
export function HoverPreview({
  info,
  rect,
  describes,
}: {
  info: HoverInfo;
  rect: DOMRect;
  cell: HTMLElement;
  describes: HTMLElement;
}) {
  const id = useId();
  useEffect(() => {
    describes.setAttribute("aria-describedby", id);
    return () => describes.removeAttribute("aria-describedby");
  }, [describes, id]);
  const above = rect.bottom + ROOM_BELOW > window.innerHeight;
  // design-audit-allow: the part's viewport position, data rather than design
  const style: CSSProperties = { left: rect.left, top: above ? rect.top : rect.bottom };
  return (
    <div
      id={id}
      role="tooltip"
      className={`pointer-events-none fixed z-popover ${above ? "-translate-y-full pb-4" : "pt-4"}`}
      style={style}
    >
      {info.kind === "record" ? (
        <RecordCard preview={info} />
      ) : info.kind === "recordKey" ? (
        <RecordKeyPreview org={info.org} recordKey={info.recordKey} />
      ) : (
        <PersonPreview org={info.org} personId={info.personId} name={info.name} />
      )}
    </div>
  );
}

/** The design system's HoverCard for a full record, else a summary of what the row has. */
function RecordCard({ preview }: { preview: RecordPreview }) {
  const { recordKind, state, stateLabel, owner, next } = preview;
  if (
    recordKind &&
    state &&
    stateLabel !== undefined &&
    owner !== undefined &&
    next !== undefined
  ) {
    return (
      <HoverCard
        recordKey={preview.recordKey}
        kind={recordKind}
        title={preview.title}
        state={state}
        stateLabel={stateLabel}
        owner={owner}
        next={next}
      />
    );
  }
  return (
    <div className={panelClass}>
      <span className="font-mono text-text-12 text-text-secondary">{preview.recordKey}</span>
      <strong className="font-semibold">{preview.title}</strong>
      {preview.detail ? <p className="m-0 text-text-secondary">{preview.detail}</p> : null}
      {owner ? <p className="m-0 text-text-secondary">{owner}</p> : null}
      {next ? <p className="m-0 text-text-secondary">{next}</p> : null}
      {state && stateLabel ? (
        <div>
          <StateChip state={state} label={stateLabel} />
        </div>
      ) : null}
    </div>
  );
}

function RecordKeyPreview({ org, recordKey }: { org: string; recordKey: string }) {
  const t = useTranslations("collab.hover") as unknown as Translate;
  const key = `${org}/${recordKey}`;
  const card = useLoaded(() => cached(records, key, () => recordCardAction(org, recordKey)), key);
  if (card) return <RecordCard preview={card} />;
  return (
    <div className={panelClass}>
      <span className="font-mono text-text-12 text-text-secondary">{recordKey}</span>
      <p className="m-0 text-text-secondary">
        {card === undefined ? t("loading") : t("unavailable")}
      </p>
    </div>
  );
}

function PersonPreview({ org, personId, name }: { org: string; personId: string; name: string }) {
  const t = useTranslations("collab.hover") as unknown as Translate;
  const format = useFormatter();
  const key = `${org}/${personId}`;
  const card = useLoaded(() => cached(people, key, () => personCardAction(org, personId)), key);
  return (
    <div className={panelClass}>
      <div className="flex items-center gap-8">
        <Avatar name={card?.name ?? name} />
        <strong className="font-semibold">{card?.name ?? name}</strong>
      </div>
      {card === undefined ? (
        <p className="m-0 text-text-secondary">{t("loading")}</p>
      ) : card === null ? (
        <p className="m-0 text-text-secondary">{t("unavailable")}</p>
      ) : (
        <>
          {card.role ? <p className="m-0 text-text-secondary">{card.role}</p> : null}
          {card.memberSince ? (
            <p className="m-0 text-text-secondary">
              {t("memberSince", {
                date: format.dateTime(new Date(card.memberSince), { dateStyle: "medium" }),
              })}
            </p>
          ) : null}
          <p className="m-0">{t("openRecords", { count: card.openRecords })}</p>
        </>
      )}
    </div>
  );
}
