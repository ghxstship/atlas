import type { Clash, ClashLink, ClashRule } from "@xos/data/schedule-clashes";

/**
 * The sentence of a clash (B4, G-46, G-47), composed in the UI from its rule and params in either locale: the
 * database returns facts and packages/data their severity, so no sentence is stored. `t` reads the schedule
 * catalog; `time` formats an instant on the clash's project clock.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

const KEYS: Readonly<Record<ClashRule, string>> = {
  person_double_booked: "clashes.rules.personDoubleBooked",
  person_in_transit: "clashes.rules.personInTransit",
  supplier_overlap: "clashes.rules.supplierOverlap",
  supplier_dock_overlap: "clashes.rules.supplierDockOverlap",
  set_two_stages: "clashes.rules.setTwoStages",
  changeover: "clashes.rules.changeover",
  arrival_near_call: "clashes.rules.arrivalNearCall",
  departure_near_call_end: "clashes.rules.departureNearCallEnd",
  past_curfew: "clashes.rules.pastCurfew",
};

/** The catalog key of a rule's name, for the rule filter and the table. */
export function ruleNameKey(rule: ClashRule): string {
  return `${KEYS[rule]}Name`;
}

export function clashSentence(
  clash: Clash,
  t: Translate,
  time: (at: string | null) => string,
  date: (at: string | null) => string,
): string {
  const p = clash.params;
  const party = p.party ?? t("clashes.someone");
  const gap = p.gap ?? 0;
  switch (clash.rule) {
    case "person_double_booked":
      return t(KEYS[clash.rule], {
        person: party,
        start: time(p.otherStartsAt),
        end: time(p.endsAt),
      });
    case "person_in_transit":
      return t(KEYS[clash.rule], {
        person: party,
        departs: time(p.otherStartsAt),
        arrives: time(p.otherEndsAt),
      });
    case "supplier_overlap":
      return t(KEYS[clash.rule], {
        supplier: party,
        from: date(p.otherStartsAt),
        to: date(p.endsAt),
      });
    case "supplier_dock_overlap":
      return t(KEYS[clash.rule], { supplier: party, time: time(p.otherStartsAt) });
    case "set_two_stages":
      return t(KEYS[clash.rule], { artist: party, time: time(p.otherStartsAt) });
    case "changeover":
      return gap < 0
        ? t("clashes.rules.setsOverlap", {
            a: party,
            b: p.other ?? t("clashes.someone"),
            gap: -gap,
          })
        : t(KEYS[clash.rule], {
            a: party,
            b: p.other ?? t("clashes.someone"),
            gap,
            min: p.minimum ?? 0,
          });
    case "arrival_near_call":
      return gap < 0
        ? t("clashes.rules.arrivalAfterCall", {
            person: party,
            arrival: time(p.endsAt),
            gap: -gap,
            call: time(p.otherStartsAt),
          })
        : t(KEYS[clash.rule], {
            person: party,
            arrival: time(p.endsAt),
            gap,
            call: time(p.otherStartsAt),
          });
    case "departure_near_call_end":
      return gap < 0
        ? t("clashes.rules.departureBeforeEnd", {
            person: party,
            departs: time(p.startsAt),
            gap: -gap,
            end: time(p.otherEndsAt),
          })
        : t(KEYS[clash.rule], {
            person: party,
            departs: time(p.startsAt),
            gap,
            end: time(p.otherEndsAt),
          });
    case "past_curfew":
      return t(KEYS[clash.rule], { run: party, minutes: gap, curfew: time(p.otherStartsAt) });
  }
}

/** Where a link opens: the page where the fix is made. */
export function clashHref(org: string, link: ClashLink): string {
  switch (link.kind) {
    case "shift":
      return `/${org}/crew/shifts?peek=${link.id}`;
    case "run_of_show":
      return `/${org}/show/run-of-show?peek=${link.id}`;
    case "cue":
      return `/${org}/show/run-of-show`;
    case "travel_segment":
      return `/${org}/hospitality/fulfillments`;
    case "engagement":
      return `/${org}/opportunities/engagements?peek=${link.id}`;
    case "dock_slot":
      return `/${org}/logistics/dock-schedule`;
  }
}

/** The catalog key of a link's label. */
export function linkLabelKey(link: ClashLink): string {
  return `clashes.links.${link.kind}`;
}
