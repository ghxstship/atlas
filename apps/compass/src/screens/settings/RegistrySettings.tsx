/**
 * Registered personal settings on a Compass settings screen (A111, ADR 0071): Preferences, Accessibility and Out of
 * Office show every setting the registry puts on their page, and Work Details its work phone, each with where its
 * value comes from and whether the org locked it, as Gateway shows them. Values are read from app.resolve_settings
 * in the active org, kept on the device, and a change queues with its optimistic row.
 */
import type { SettingDefinition } from "@xos/schemas/settings";
import type { Row } from "@xos/sync";
import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useCompass } from "../../runtime/CompassProvider";
import {
  checkSettingValue,
  choiceLabelKey,
  controlOf,
  deviceNoteKey,
  PERSONAL_MIRROR,
  personalClear,
  personalRows,
  personalWrite,
  registryKeys,
  sectionSettings,
  settingOf,
  sourceKey,
  type RegistrySection,
  type ResolvedRow,
  type SettingProblem,
} from "../../settings/preferences";
import { zoneLabel } from "../../settings/zones";
import {
  Button,
  Card,
  InlineAlert,
  ListRow,
  Screen,
  Switch,
  Text,
  TextField,
  useTheme,
} from "../../ui";
import { ChoiceRow, ChoiceSheet, ZoneSheet } from "./ChoiceSheet";
import { useMirror, useQueuedWrite, type Mirror } from "./hooks";
import { LabeledChoice, OfflineNotice, WriteNotice } from "./parts";

/** app.resolve_settings needs an org; the nil uuid answers with the person's own values and the defaults. */
const NO_ORG = "00000000-0000-0000-0000-000000000000";

/** Refusals of the 0850 guard with their own sentence under `settings.errors`. */
const SETTING_RULES: ReadonlySet<string> = new Set([
  "setting_locked",
  "setting_choice",
  "setting_too_long",
  "setting_value_type",
  "setting_unknown",
]);

const ruleKey = (rule: string) => (SETTING_RULES.has(rule) ? `settings.errors.${rule}` : undefined);

/** The message key of what is wrong with a typed value. */
function problemKey(problem: SettingProblem): string {
  if (problem === "date") return "compassPersonal.registry.date";
  if (problem === "zone") return "settings.notifications.errors.time_zone_unknown";
  return `settings.errors.${problem}`;
}

/**
 * The device copy of the person's registered settings, read from app.resolve_settings in their active member org
 * (whose locks apply to them), or with no org for someone without a membership.
 */
export function useRegistrySettings(): Mirror<Row> {
  const { client, resolved } = useCompass();
  const orgId = resolved?.identity.membershipId ? resolved.orgId : null;
  const read = useCallback(async () => {
    const { data, error } = await client.rpc("resolve_settings", { p_org_id: orgId ?? NO_ORG });
    if (error || !Array.isArray(data)) return null;
    return personalRows(data as ResolvedRow[], registryKeys());
  }, [client, orgId]);
  return useMirror(PERSONAL_MIRROR, read);
}

/** A check one setting's value needs beyond its own, such as an out-of-office end after its start. */
export type CrossCheck = (value: string | boolean | number | null) => string | null;

/** One registered setting: its control, where its value comes from, and the answer to a change. */
export function RegistrySetting({
  def,
  row,
  orgName,
  check,
}: {
  readonly def: SettingDefinition;
  readonly row: Row | undefined;
  /** The active org's name, for a value it locked. */
  readonly orgName: string;
  readonly check?: CrossCheck | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { personZone } = useCompass();
  const write = useQueuedWrite();
  const [sheet, setSheet] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const setting = settingOf(def, row);
  const testID = `setting-${def.key}`;
  const label = t(def.label);
  const help = def.help ? t(def.help) : undefined;
  const shown = setting.value === null ? "" : String(setting.value);
  const control = controlOf(def);

  const save = (raw: string | boolean) => {
    const checked = checkSettingValue(def, raw);
    if (!checked.ok) {
      setProblem(t(problemKey(checked.problem)));
      return;
    }
    const other = check?.(checked.value) ?? null;
    if (other) {
      setProblem(t(other));
      return;
    }
    setProblem(null);
    setDraft(null);
    const input =
      checked.value === null ? personalClear(def, row) : personalWrite(def.key, row, checked.value);
    if (input) void write.save(input);
  };
  const inherit = () => {
    const input = personalClear(def, row);
    setDraft(null);
    if (input) void write.save(input);
  };
  const choiceLabel = (choice: string) => t(choiceLabelKey(def.key, choice));

  let body: ReactNode;
  switch (control) {
    case "switch":
      body = (
        <Switch
          testID={testID}
          label={label}
          {...(help ? { help } : {})}
          value={setting.value === true}
          disabled={setting.locked}
          onChange={save}
        />
      );
      break;
    case "segments":
      body = setting.locked ? (
        <ListRow testID={testID} title={label} subtitle={choiceLabel(shown)} />
      ) : (
        <LabeledChoice
          testID={testID}
          label={label}
          value={shown}
          options={def.choices.map((c) => ({ value: c, label: choiceLabel(c) }))}
          onChange={save}
        />
      );
      break;
    case "choices":
      body = (
        <>
          <ChoiceRow
            testID={testID}
            title={label}
            value={setting.value === null ? t("workDetails.notSet") : choiceLabel(shown)}
            disabled={setting.locked}
            onPress={() => setSheet(true)}
          />
          <ChoiceSheet
            testID={`${testID}-sheet`}
            open={sheet}
            title={label}
            value={shown}
            choices={def.choices.map((c) => ({ value: c, label: choiceLabel(c) }))}
            onChoose={save}
            onClose={() => setSheet(false)}
          />
        </>
      );
      break;
    case "zone":
      body = (
        <>
          <ChoiceRow
            testID={testID}
            title={label}
            value={zoneLabel(setting.source === "Personal" ? shown : personZone)}
            disabled={setting.locked}
            onPress={() => setSheet(true)}
          />
          <ZoneSheet
            testID={`${testID}-sheet`}
            open={sheet}
            title={label}
            value={setting.source === "Personal" ? shown : ""}
            deviceZone={personZone}
            onChoose={save}
            onClose={() => setSheet(false)}
          />
        </>
      );
      break;
    default:
      body = (
        <>
          <TextField
            testID={testID}
            label={label}
            {...(control === "date"
              ? { help: t("compassPersonal.registry.dateHelp") }
              : help
                ? { help }
                : {})}
            {...(problem ? { error: problem } : {})}
            value={draft ?? shown}
            onChangeText={setDraft}
            multiline={control === "multiline"}
            disabled={setting.locked}
            autoComplete="off"
          />
          {setting.locked ? null : (
            <Button
              testID={`${testID}-save`}
              label={t("compass.common.save")}
              variant="secondary"
              disabled={draft === null || draft === shown}
              onPress={() => save(draft ?? "")}
            />
          )}
        </>
      );
  }

  const note = deviceNoteKey(setting);
  return (
    <View style={{ gap: theme.space["8"] }}>
      {body}
      {control !== "switch" && help && control !== "text" && control !== "multiline" ? (
        <Text variant="text13" tone="tertiary">
          {help}
        </Text>
      ) : null}
      {problem && control !== "date" && control !== "text" && control !== "multiline" ? (
        <InlineAlert testID={`${testID}-problem`} tone="danger" message={problem} />
      ) : null}
      {/* Where the value comes from, or what Compass uses instead when it differs from the shells. */}
      <Text variant="text13" tone="tertiary" testID={`${testID}-source`}>
        {note
          ? t(note, { zone: zoneLabel(personZone) })
          : def.deferred
            ? `${t(sourceKey(setting), { org: orgName })} ${t("settings.notInEffect")}`
            : t(sourceKey(setting), { org: orgName })}
      </Text>
      {setting.source === "Personal" && !setting.locked ? (
        <Button
          testID={`${testID}-inherit`}
          label={t("settings.inherit")}
          variant="ghost"
          onPress={inherit}
        />
      ) : null}
      <WriteNotice testID={`${testID}-write`} state={write.state} ruleKey={ruleKey} />
    </View>
  );
}

/** The active org's name, for the sentence that says it locked a value. */
export function useOrgName(): string {
  const { resolved } = useCompass();
  return resolved?.contexts.find((c) => c.orgId === resolved.orgId)?.orgName ?? "";
}

/** A settings screen of registered settings, with an extra card or two after them when the section has its own. */
export function RegistrySettingsScreen({
  section,
  title,
  testID,
  checks,
  children,
}: {
  readonly section: RegistrySection;
  readonly title: string;
  readonly testID: string;
  /** Cross-field checks by setting key. */
  readonly checks?: (rows: readonly Row[]) => Readonly<Record<string, CrossCheck>>;
  readonly children?: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const { network } = useCompass();
  const mirror = useRegistrySettings();
  const orgName = useOrgName();
  const defs = sectionSettings(section);
  const byKey = checks?.(mirror.rows) ?? {};
  return (
    <Screen testID={testID} title={title} refreshing={false} onRefresh={mirror.reload}>
      {network.isConnected ? null : <OfflineNotice kind={mirror.notLoaded ? "first" : "queues"} />}
      {mirror.failed ? (
        <InlineAlert
          testID={`${testID}-failed`}
          tone="danger"
          message={t("compassPersonal.loadFailed")}
        />
      ) : null}
      {mirror.notLoaded
        ? null
        : defs.map((def) => (
            <Card key={def.key}>
              <RegistrySetting
                def={def}
                row={mirror.rows.find((r) => r.id === def.key)}
                orgName={orgName}
                check={byKey[def.key]}
              />
            </Card>
          ))}
      {children}
    </Screen>
  );
}
