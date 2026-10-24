"use client";

import type { PersonCard } from "@xos/data/person-card";
import { Avatar, HoverCard } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useState, type CSSProperties } from "react";
import { personCardAction } from "@/lib/hover/actions";
import type { HoverInfo } from "./use-hover-cards";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Person cards fetched this session, so moving back over a name never refetches it. */
const people = new Map<string, Promise<PersonCard | null>>();

function personCard(org: string, personId: string): Promise<PersonCard | null> {
  const key = `${org}/${personId}`;
  let card = people.get(key);
  if (!card) {
    card = personCardAction(org, personId).catch(() => null);
    people.set(key, card);
  }
  return card;
}

/** The space a card needs below its cell before it opens above instead. */
const ROOM_BELOW = 220;

/**
 * A hover card beside its cell (Section 11.7), loaded on demand by useHoverCards: a record's title,
 * state, owner and next date, or a person's role, membership and open records. It never takes focus;
 * the cell is described by it while it shows.
 */
export function HoverPreview({
  info,
  rect,
  cell,
}: {
  info: HoverInfo;
  rect: DOMRect;
  cell: HTMLElement;
}) {
  const id = useId();
  useEffect(() => {
    cell.setAttribute("aria-describedby", id);
    return () => cell.removeAttribute("aria-describedby");
  }, [cell, id]);
  const above = rect.bottom + ROOM_BELOW > window.innerHeight;
  // design-audit-allow: the cell's viewport position, data rather than design
  const style: CSSProperties = { left: rect.left, top: above ? rect.top : rect.bottom };
  return (
    <div
      id={id}
      role="tooltip"
      className={`pointer-events-none fixed z-popover ${above ? "-translate-y-full pb-4" : "pt-4"}`}
      style={style}
    >
      {info.kind === "record" ? (
        <HoverCard
          recordKey={info.recordKey}
          kind={info.recordKind}
          title={info.title}
          state={info.state}
          stateLabel={info.stateLabel}
          owner={info.owner}
          next={info.next}
        />
      ) : (
        <PersonPreview org={info.org} personId={info.personId} name={info.name} />
      )}
    </div>
  );
}

function PersonPreview({ org, personId, name }: { org: string; personId: string; name: string }) {
  const t = useTranslations("collab.hover") as unknown as Translate;
  const format = useFormatter();
  const [card, setCard] = useState<PersonCard | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void personCard(org, personId).then((c) => {
      if (live) setCard(c);
    });
    return () => {
      live = false;
    };
  }, [org, personId]);
  return (
    <div className="flex w-(--ui-hovercard) flex-col gap-6 rounded-card bg-bg-raised p-12 text-text-13 text-text-primary shadow-menu forced-colors:border">
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
