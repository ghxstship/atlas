/**
 * Project details in Compass (R5): the list of the person's live roster entries, and one entry's Travel, Uniform and
 * Vehicle cards, each only when the project offers it. Reads and saves are online with the person's session and never
 * cached or queued (src/domain/projectDetails.ts); offline, the save buttons are disabled and say why.
 */
import type { XosClient } from "@xos/data";
import { listMyRosterEntries, type MyRosterEntry } from "@xos/data/roster";
import {
  getRosterProjectFacts,
  SHOE_SIZE_SYSTEMS,
  type ProjectFactKind,
  type RosterProjectFacts,
} from "@xos/data/roster-facts";
import { SHOE_SIZE_SYSTEM_KEYS } from "@xos/data/roster-facts-display";
import { SEAT_PREFERENCES, workDetailLabelKey } from "@xos/data/work-details";
import { useRouter, type Href } from "expo-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  factFields,
  liveEntries,
  projectDetailCards,
  saveProjectFact,
  type FactSave,
} from "../domain/projectDetails";
import { useCompass } from "../runtime/CompassProvider";
import { SIZE_CHOICES } from "../settings/workDetails";
import { Button, Card, InlineAlert, ListRow, Screen, Switch, Text, TextField } from "../ui";
import { ChoiceRow, ChoiceSheet } from "./settings/ChoiceSheet";
import { LabeledChoice } from "./settings/parts";

const P = "workDetails.projectFacts";

function useOnline(): { db: XosClient; online: boolean } {
  const { client, network } = useCompass();
  return { db: client as unknown as XosClient, online: network.isConnected };
}

/** The person's live roster entries; each opens its project details. */
export function ProjectDetailsList(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { db, online } = useOnline();
  const [rows, setRows] = useState<readonly MyRosterEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!online) return undefined;
    let live = true;
    void listMyRosterEntries(db).then((r) => {
      if (!live) return;
      if (r.ok) setRows(liveEntries(r.data));
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [db, online]);
  return (
    <Screen testID="project-details" title={t("nav.compass.more.projectDetails")}>
      <Text tone="secondary">{t(`${P}.sentence`)}</Text>
      {!online ? (
        <InlineAlert testID="project-details-offline" tone="info" message={t(`${P}.offline`)} />
      ) : failed ? (
        <InlineAlert
          testID="project-details-failed"
          tone="danger"
          message={t("compassPersonal.loadFailed")}
        />
      ) : !rows ? (
        <Text tone="tertiary">{t("compass.common.loading")}</Text>
      ) : rows.length === 0 ? (
        <InlineAlert testID="project-details-empty" tone="info" message={t(`${P}.none`)} />
      ) : (
        <Card testID="project-details-entries">
          {rows.map((r) => (
            <ListRow
              key={r.id}
              testID={`project-details-entry-${r.id}`}
              icon="clipboard-list"
              title={r.projectName ?? ""}
              subtitle={[r.partyName ?? r.orgName, r.jobTitle].filter(Boolean).join(" · ")}
              onPress={() => router.push(`/project-details/${r.id}` as Href)}
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}

/** One entry's cards, read once online. */
export function ProjectDetailsEntry({ entryId }: { readonly entryId: string }): ReactElement {
  const { t } = useTranslation();
  const { db, online } = useOnline();
  const [facts, setFacts] = useState<RosterProjectFacts | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!online) return undefined;
    let live = true;
    void getRosterProjectFacts(db, entryId).then((r) => {
      if (!live) return;
      if (r.ok) setFacts(r.data);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [db, online, entryId, attempt]);
  const cards = facts ? projectDetailCards(facts) : [];
  return (
    <Screen testID="project-details-entry" title={t(`${P}.title`)}>
      {!online ? (
        <InlineAlert testID="project-details-offline" tone="info" message={t(`${P}.offline`)} />
      ) : null}
      {failed ? (
        <InlineAlert
          testID="project-details-failed"
          tone="danger"
          message={t("compassPersonal.loadFailed")}
        />
      ) : !facts ? (
        online ? (
          <Text tone="tertiary">{t("compass.common.loading")}</Text>
        ) : null
      ) : cards.length === 0 ? (
        <Text tone="secondary">{t(`${P}.none`)}</Text>
      ) : (
        cards.map((kind) => (
          <FactCard
            key={kind}
            db={db}
            online={online}
            kind={kind}
            facts={facts}
            onSaved={() => setAttempt((n) => n + 1)}
          />
        ))
      )}
    </Screen>
  );
}

const KEY = { Travel: "travel", Uniform: "uniform", Vehicle: "vehicle" } as const;

function FactCard({
  db,
  online,
  kind,
  facts,
  onSaved,
}: {
  readonly db: XosClient;
  readonly online: boolean;
  readonly kind: ProjectFactKind;
  readonly facts: RosterProjectFacts;
  readonly onSaved: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [fields, setFields] = useState(() => factFields(kind, facts));
  const [state, setState] = useState<FactSave | { kind: "idle" | "saving" }>({ kind: "idle" });
  const [sheet, setSheet] = useState<string | null>(null);
  const set = (name: string) => (value: string) => setFields((f) => ({ ...f, [name]: value }));
  const id = `project-${KEY[kind]}`;
  const label = (name: string) => t(`${P}.fields.${name}.label`);
  const help = (name: string) => t(`${P}.fields.${name}.help`);
  const error = (name: string) =>
    state.kind === "invalid" && state.fields[name] ? { error: t(state.fields[name]) } : {};
  const text = (name: string, labelOf = name, keyboard?: "numeric" | "decimal-pad") => (
    <TextField
      key={name}
      testID={`${id}-${name}`}
      label={label(labelOf)}
      help={help(labelOf)}
      value={fields[name] ?? ""}
      onChangeText={set(name)}
      autoComplete="off"
      {...(keyboard ? { keyboardType: keyboard } : {})}
      {...error(name)}
    />
  );
  const size = (name: string) => (
    <ChoiceRow
      key={name}
      testID={`${id}-${name}`}
      title={label(name)}
      value={fields[name] || t("workDetails.notSet")}
      onPress={() => setSheet(name)}
    />
  );
  const sizeSheets = ["shirtSize", "jacketSize", "pantsSize", "gloveSize", "hatSize"].map(
    (name) => (
      <ChoiceSheet
        key={`${name}-sheet`}
        testID={`${id}-${name}-sheet`}
        open={sheet === name}
        title={label(name)}
        value={fields[name] ?? ""}
        choices={SIZE_CHOICES.map((s) => ({ value: s, label: s || t("workDetails.notSet") }))}
        onChoose={set(name)}
        onClose={() => setSheet(null)}
      />
    ),
  );
  const toggle = (name: string) => (
    <Switch
      key={name}
      testID={`${id}-${name}`}
      label={label(name)}
      value={fields[name] === "on"}
      onChange={() => setFields((f) => ({ ...f, [name]: f[name] === "on" ? "" : "on" }))}
    />
  );
  let body: ReactElement[];
  if (kind === "Travel") {
    body = [
      text("inboundAirportCode", "inboundAirport"),
      text("inboundOn"),
      text("outboundAirportCode", "outboundAirport"),
      text("outboundOn"),
      toggle("needsGroundTransport"),
      ...(facts.offered.lodging ? [toggle("needsLodging")] : []),
      <LabeledChoice
        key="seatPreference"
        testID={`${id}-seatPreference`}
        label={label("seatPreference")}
        value={fields["seatPreference"] ?? ""}
        options={[
          { value: "", label: t("workDetails.notSet") },
          ...SEAT_PREFERENCES.map((s) => ({
            value: s,
            label: t(`workDetails.seatPreferences.${workDetailLabelKey(s)}`),
          })),
        ]}
        onChange={set("seatPreference")}
      />,
      text("mealPreference"),
      text("travelNotes"),
    ];
  } else if (kind === "Uniform") {
    body = [
      size("shirtSize"),
      size("jacketSize"),
      size("pantsSize"),
      text("shoeSize", "shoeSize", "decimal-pad"),
      <LabeledChoice
        key="shoeSizeSystem"
        testID={`${id}-shoeSizeSystem`}
        label={label("shoeSizeSystem")}
        value={fields["shoeSizeSystem"] ?? ""}
        options={[
          { value: "", label: t("workDetails.notSet") },
          ...SHOE_SIZE_SYSTEMS.map((s) => ({
            value: s,
            label: t(`${P}.shoeSizeSystems.${SHOE_SIZE_SYSTEM_KEYS[s]}`),
          })),
        ]}
        onChange={set("shoeSizeSystem")}
      />,
      size("gloveSize"),
      size("hatSize"),
      text("pantsWaistIn", "pantsWaistIn", "numeric"),
      text("pantsInseamIn", "pantsInseamIn", "numeric"),
      ...sizeSheets,
    ];
  } else {
    body = ["make", "model", "color", "plate", "plateRegion"].map((name) => text(name));
  }
  const save = async () => {
    setState({ kind: "saving" });
    const result = await saveProjectFact(db, facts.rosterEntryId, kind, fields);
    setState(result);
    if (result.kind === "saved") onSaved();
  };
  return (
    <Card title={t(`${P}.kinds.${KEY[kind]}`)} testID={id}>
      {body}
      <Button
        testID={`${id}-save`}
        label={t("compass.common.save")}
        disabled={!online}
        loading={state.kind === "saving"}
        onPress={() => void save()}
      />
      {!online ? (
        <Text variant="text13" tone="secondary">
          {t(`${P}.offline`)}
        </Text>
      ) : null}
      {state.kind === "saved" ? (
        <InlineAlert testID={`${id}-saved`} tone="success" message={t(`${P}.saved`)} />
      ) : state.kind === "failed" ? (
        <InlineAlert testID={`${id}-failed`} tone="danger" message={t(state.key)} />
      ) : null}
    </Card>
  );
}
