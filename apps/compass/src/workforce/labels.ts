/**
 * Translated labels for the Workforce screens (@xos/workforce-native takes every string through `labels`).
 * Compass owns the copy: the "workforce" namespace, with its Compass screens under workforce.compass and
 * the shared enum and refusal copy the Atlas pages already use.
 */
import type {
  ChatThreadScreenLabels,
  ConversationsScreenLabels,
  DirectoryScreenLabels,
  DoorCheckInScreenLabels,
  EventsScreenLabels,
  FeedScreenLabels,
  FormFillScreenLabels,
  FrameLabels,
  HandbookScreenLabels,
  HelpDeskScreenLabels,
  LostFoundScreenLabels,
  OccupancyCounterScreenLabels,
  RecognitionScreenLabels,
  SurveyScreenLabels,
  TrainingScreenLabels,
  WeatherScreenLabels,
} from "@xos/workforce-native";
import { HAZARD_MEASURES } from "@xos/data/workforce-site";
import {
  displayUnitFor,
  toDisplayUnit,
  unitSymbol,
  type MeasureUnit,
  type UnitSystem,
} from "@xos/i18n/units";
import { countKey } from "../runtime/i18n";

export type T = (key: string, values?: Record<string, string | number>) => string;

const C = "workforce.compass";

/** "Crew Call" to "crewCall": the catalog segment of a stored enum value. */
export function enumKey(value: string): string {
  const words = value
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/);
  return words
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join("");
}

function record<K extends string>(values: readonly K[], t: T, base: string): Record<K, string> {
  return Object.fromEntries(values.map((v) => [v, t(`${base}.${enumKey(v)}`)])) as Record<
    K,
    string
  >;
}

function when(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

function day(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(`${iso.slice(0, 10)}T12:00:00Z`),
  );
}

export function frame(t: T, title: string): FrameLabels {
  return {
    title,
    loading: t(`${C}.common.loading`),
    errorTitle: t(`${C}.common.errorTitle`),
    errorSentence: t(`${C}.common.errorSentence`),
    retry: t(`${C}.common.retry`),
  };
}

export function feedLabels(t: T): FeedScreenLabels {
  return {
    ...frame(t, t(`${C}.feed.title`)),
    empty: t(`${C}.feed.empty`),
    emptyAction: t(`${C}.common.refresh`),
    failed: t(`${C}.common.failed`),
    pinned: t(`${C}.feed.pinned`),
    mustAcknowledge: t(`${C}.feed.mustAcknowledge`),
    acknowledge: t(`${C}.feed.acknowledge`),
    acknowledged: t(`${C}.feed.acknowledged`),
    vote: t(`${C}.feed.vote`),
    voted: t(`${C}.feed.voted`),
    comments: t(`${C}.feed.comments`),
    kinds: record(["Announcement", "Update", "Poll", "Recognition"], t, `${C}.feed.kinds`),
    reaction: (code, count, mine) =>
      t(mine ? `${C}.feed.reactionMine` : `${C}.feed.reaction`, {
        name: t(`${C}.feed.reactions.${code}`),
        count,
      }),
    byline: (author, publishAt) =>
      t(`${C}.feed.byline`, { author: author ?? t("workforce.someone"), time: when(publishAt) }),
  };
}

export function surveyLabels(t: T, title: string): SurveyScreenLabels {
  return {
    ...frame(t, title),
    submit: t(`${C}.survey.submit`),
    submitted: t(`${C}.survey.submitted`),
    failed: t(`${C}.common.failed`),
    closed: t(`${C}.survey.closed`),
    anonymous: t(`${C}.survey.anonymous`),
    optionalQuestion: (prompt) => t(`${C}.survey.optional`, { prompt }),
    answerRequired: (count) => t(`${C}.survey.answerRequired`, { count }),
  };
}

export function conversationsLabels(t: T): ConversationsScreenLabels {
  return {
    ...frame(t, t(`${C}.chat.title`)),
    empty: t(`${C}.chat.empty`),
    newMessage: t(`${C}.chat.newMessage`),
    muted: t(`${C}.chat.muted`),
    noMessages: t(`${C}.chat.noMessages`),
    unread: (count) => t(`${C}.chat.unread`, { count }),
  };
}

export function threadLabels(t: T, title: string): ChatThreadScreenLabels {
  return {
    ...frame(t, title),
    empty: t(`${C}.chat.threadEmpty`),
    message: t(`${C}.chat.message`),
    send: t(`${C}.chat.send`),
    failed: t(`${C}.common.failed`),
    edited: t(`${C}.chat.edited`),
    you: t(`${C}.chat.you`),
    someone: t("workforce.someone"),
    attachment: t(`${C}.chat.attachment`),
    meta: (author, createdAt) => t(`${C}.chat.meta`, { author, time: when(createdAt) }),
  };
}

export function directoryLabels(t: T): DirectoryScreenLabels {
  return {
    ...frame(t, t(`${C}.directory.title`)),
    search: t(`${C}.directory.search`),
    empty: t(`${C}.directory.empty`),
    clearSearch: t(`${C}.directory.clearSearch`),
    scope: t(`${C}.directory.scope`),
    everyone: t(`${C}.directory.everyone`),
    onSiteNow: t(`${C}.directory.onSiteNow`),
    onSite: t(`${C}.directory.onSite`),
    call: (name) => t(`${C}.directory.call`, { name }),
    message: (name) => t(`${C}.directory.message`, { name }),
    recognitions: (count) => t(`${C}.directory.recognitions`, { count }),
  };
}

export function eventsLabels(t: T): EventsScreenLabels {
  return {
    ...frame(t, t(`${C}.events.title`)),
    empty: t(`${C}.events.empty`),
    emptyAction: t(`${C}.common.refresh`),
    failed: t(`${C}.common.failed`),
    checkIn: t(`${C}.events.checkIn`),
    checkedIn: t(`${C}.events.checkedIn`),
    kinds: record(["Briefing", "Crew Call", "Meeting"], t, `${C}.events.kinds`),
    responses: record(["Going", "Maybe", "Declined"], t, `${C}.events.responses`),
    phases: {
      canceled: t(`${C}.events.phases.canceled`),
      past: t(`${C}.events.phases.past`),
      live: t(`${C}.events.phases.live`),
      upcoming: t(`${C}.events.phases.upcoming`),
    },
    when: (startsAt, endsAt, location) =>
      t(location ? `${C}.events.whenAt` : `${C}.events.when`, {
        start: when(startsAt),
        end: new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(endsAt)),
        location: location ?? "",
      }),
    counts: (counts) => t(`${C}.events.counts`, counts),
  };
}

export function formLabels(t: T, title: string, location: string): FormFillScreenLabels {
  return {
    ...frame(t, title),
    submit: t(`${C}.forms.submit`),
    submitted: t(`${C}.forms.submitted`),
    failed: t(`${C}.common.failed`),
    yes: t("workforce.yes"),
    no: t("workforce.no"),
    required: t(`${C}.forms.required`),
    requiredField: (label) => t(`${C}.forms.requiredField`, { label }),
    missing: (count) => t(countKey(`${C}.forms.missing`, count), { count }),
    score: (score, max, pass) =>
      pass === null
        ? t(`${C}.forms.score`, { score, max })
        : t(`${C}.forms.scorePass`, { score, max, pass }),
    addPhoto: t(`${C}.forms.addPhoto`),
    photos: (count) => t(countKey(`${C}.forms.photos`, count), { count }),
    dateHelp: t(`${C}.forms.dateHelp`),
    numberError: t(`${C}.forms.numberError`),
    signature: t(`${C}.forms.signature`),
    attestation: t(`${C}.forms.attestation`),
    clearSignature: t(`${C}.forms.clearSignature`),
    signatureMissing: t(`${C}.forms.signatureMissing`),
    location,
  };
}

export function trainingLabels(t: T): TrainingScreenLabels {
  return {
    ...frame(t, t(`${C}.training.title`)),
    empty: t(`${C}.training.empty`),
    emptyAction: t(`${C}.common.refresh`),
    failed: t(`${C}.common.failed`),
    back: t(`${C}.common.back`),
    lessons: t(`${C}.training.lessons`),
    markComplete: t(`${C}.training.markComplete`),
    lessonDone: t(`${C}.training.lessonDone`),
    watchVideo: t(`${C}.training.watchVideo`),
    submitQuiz: t(`${C}.training.submitQuiz`),
    answerAll: t(`${C}.training.answerAll`),
    passed: t(`${C}.training.passed`),
    retake: t(`${C}.training.retake`),
    progress: (done, total) => t(`${C}.training.progress`, { done, total }),
    courseMeta: (dueOn, minutes) =>
      [
        dueOn ? t(`${C}.training.due`, { date: day(dueOn) }) : null,
        minutes ? t(`${C}.training.minutes`, { minutes }) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    passMark: (percent) => t(`${C}.training.passMark`, { percent }),
  };
}

export function handbookLabels(t: T): HandbookScreenLabels {
  return {
    ...frame(t, t(`${C}.handbook.title`)),
    search: t(`${C}.handbook.search`),
    empty: t(`${C}.handbook.empty`),
    clearSearch: t(`${C}.directory.clearSearch`),
    failed: t(`${C}.common.failed`),
    mandatory: t(`${C}.handbook.mandatory`),
    mustRead: t(`${C}.handbook.mustRead`),
    allArticles: t(`${C}.handbook.allArticles`),
    acknowledge: t(`${C}.handbook.acknowledge`),
    acknowledged: t(`${C}.handbook.acknowledged`),
    back: t(`${C}.common.back`),
    changes: (summary) => t(`${C}.handbook.changes`, { summary }),
  };
}

export function recognitionLabels(t: T): RecognitionScreenLabels {
  return {
    ...frame(t, t(`${C}.recognition.title`)),
    empty: t(`${C}.recognition.empty`),
    give: t(`${C}.recognition.give`),
    failed: t(`${C}.common.failed`),
    sheetTitle: t(`${C}.recognition.sheetTitle`),
    close: t(`${C}.common.close`),
    who: t(`${C}.recognition.who`),
    message: t(`${C}.recognition.message`),
    messageHelp: t(`${C}.recognition.messageHelp`),
    send: t(`${C}.recognition.send`),
    line: (from, to, createdAt) =>
      t(`${C}.recognition.line`, {
        from: from ?? t("workforce.someone"),
        to: to ?? t("workforce.someone"),
        time: when(createdAt),
      }),
  };
}

export function helpDeskLabels(t: T): HelpDeskScreenLabels {
  return {
    ...frame(t, t(`${C}.helpDesk.title`)),
    empty: t(`${C}.helpDesk.empty`),
    ask: t(`${C}.helpDesk.ask`),
    failed: t(`${C}.common.failed`),
    sheetTitle: t(`${C}.helpDesk.sheetTitle`),
    close: t(`${C}.common.close`),
    team: t(`${C}.helpDesk.team`),
    category: t(`${C}.helpDesk.category`),
    subject: t(`${C}.helpDesk.subject`),
    body: t(`${C}.helpDesk.body`),
    send: t(`${C}.helpDesk.send`),
    overdue: t(`${C}.helpDesk.overdue`),
    states: record(["Open", "Waiting", "Resolved", "Closed"], t, `${C}.helpDesk.states`),
    categories: record(
      ["Question", "Problem", "Access", "Billing", "Account", "Feature Request"],
      t,
      `${C}.helpDesk.categories`,
    ),
    meta: (number, assignee, createdAt) =>
      t(assignee ? `${C}.helpDesk.metaAssigned` : `${C}.helpDesk.meta`, {
        number,
        assignee: assignee ?? "",
        time: when(createdAt),
      }),
  };
}

export function occupancyLabels(t: T): OccupancyCounterScreenLabels {
  return {
    ...frame(t, t(`${C}.occupancy.title`)),
    empty: t(`${C}.occupancy.empty`),
    emptyAction: t(`${C}.common.refresh`),
    failed: t(`${C}.common.failed`),
    counter: t(`${C}.occupancy.counter`),
    door: t(`${C}.occupancy.door`),
    closed: t(`${C}.occupancy.closed`),
    add: (n) => t(`${C}.occupancy.add`, { n }),
    remove: (n) => t(`${C}.occupancy.remove`, { n }),
    count: (count, permitted) => t(`${C}.occupancy.count`, { count, permitted }),
    percent: (percent) => t(`${C}.occupancy.percent`, { percent }),
    level: (level) => t(`${C}.occupancy.level${level}`),
  };
}

/**
 * The units weather values show in on this device (locale.units through unitSystemOf): readings and thresholds
 * are stored in mph, miles and degrees Fahrenheit and converted here for display.
 */
export interface WeatherUnits {
  readonly locale: string;
  readonly system: UnitSystem;
}

const STORED_IMPERIAL: WeatherUnits = { locale: "en-US", system: "imperial" };

function hazardMeasure(unit: string): MeasureUnit | null {
  return unit in HAZARD_MEASURES ? HAZARD_MEASURES[unit as keyof typeof HAZARD_MEASURES] : null;
}

export function weatherLabels(t: T, units: WeatherUnits = STORED_IMPERIAL): WeatherScreenLabels {
  const symbol = (unit: string) => {
    const measure = hazardMeasure(unit);
    return measure ? unitSymbol(units.locale, displayUnitFor(measure, units.system)) : unit;
  };
  const shown = (value: number, unit: string) => {
    const measure = hazardMeasure(unit);
    return measure ? toDisplayUnit(value, measure, units.system, 1) : value;
  };
  return {
    ...frame(t, t(`${C}.weather.title`)),
    failed: t(`${C}.common.failed`),
    alerts: t(`${C}.weather.alerts`),
    noAlerts: t(`${C}.weather.noAlerts`),
    readings: t(`${C}.weather.readings`),
    noReadings: t(`${C}.weather.noReadings`),
    thresholds: t(`${C}.weather.thresholds`),
    noThresholds: t(`${C}.weather.noThresholds`),
    record: t(`${C}.weather.record`),
    hazard: t(`${C}.weather.hazard`),
    value: (unit) => t(`${C}.weather.value`, { unit: symbol(unit) }),
    valueError: t(`${C}.weather.valueError`),
    save: t(`${C}.weather.save`),
    hazards: record(["Wind", "Lightning", "Heat"], t, `${C}.weather.hazards`),
    levels: record(["Monitor", "Restrict", "Evacuate"], t, `${C}.weather.levels`),
    alertLine: (hazard, level, issuedAt) =>
      t(`${C}.weather.alertLine`, { hazard, level, time: when(issuedAt) }),
    readingLine: (value, unit, observedAt) =>
      t(`${C}.weather.readingLine`, {
        value: shown(value, unit),
        unit: symbol(unit),
        time: when(observedAt),
      }),
    thresholdLine: (level, value, unit, source) =>
      t(`${C}.weather.thresholdLine`, {
        level,
        value: shown(value, unit),
        unit: symbol(unit),
        source,
      }),
  };
}

export function doorLabels(t: T): DoorCheckInScreenLabels {
  return {
    ...frame(t, t(`${C}.door.title`)),
    search: t(`${C}.door.search`),
    empty: t(`${C}.door.empty`),
    clearSearch: t(`${C}.directory.clearSearch`),
    failed: t(`${C}.common.failed`),
    checkIn: t(`${C}.door.checkIn`),
    checkedIn: t(`${C}.door.checkedIn`),
    approved: t(`${C}.door.approved`),
    door: t(`${C}.door.door`),
    sheetTitle: (name) => t(`${C}.door.sheetTitle`, { name }),
    close: t(`${C}.common.close`),
    confirm: t(`${C}.door.confirm`),
    plusOnes: (admitted, allowed) => t(`${C}.door.plusOnes`, { admitted, allowed }),
    more: t(`${C}.door.more`),
    fewer: t(`${C}.door.fewer`),
    admitted: (plusOnes, door, at) =>
      t(door ? `${C}.door.admittedAt` : `${C}.door.admitted`, {
        plusOnes,
        door: door ?? "",
        time: when(at),
      }),
  };
}

export function lostFoundLabels(t: T): LostFoundScreenLabels {
  return {
    ...frame(t, t(`${C}.lostFound.title`)),
    empty: t(`${C}.lostFound.empty`),
    log: t(`${C}.lostFound.log`),
    failed: t(`${C}.common.failed`),
    sheetTitle: t(`${C}.lostFound.sheetTitle`),
    close: t(`${C}.common.close`),
    category: t(`${C}.lostFound.category`),
    description: t(`${C}.lostFound.description`),
    foundLocation: t(`${C}.lostFound.foundLocation`),
    storageLocation: t(`${C}.lostFound.storageLocation`),
    save: t(`${C}.lostFound.save`),
    categories: record(
      ["Bag", "Clothing", "Electronics", "Jewelry", "Keys", "Documents", "Wallet", "Other"],
      t,
      `${C}.lostFound.categories`,
    ),
    states: record(["Logged", "Claimed", "Returned", "Disposed"], t, `${C}.lostFound.states`),
    itemTitle: (category, description) => t(`${C}.lostFound.itemTitle`, { category, description }),
    meta: (number, foundLocation, openClaims) =>
      t(`${C}.lostFound.meta`, { number, place: foundLocation, count: openClaims }),
  };
}
