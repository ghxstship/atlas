/**
 * Settings, Work Details in Compass (Section 4.5.6 personal settings item 10, A111, ADR 0071): the work phone, and
 * the person's dietary and accessibility needs and emergency contacts. The forms read and save online with the
 * person's session (owner-only rows, migration 1340), checked by the parsers Atlas and Gateway share; nothing of them
 * stays on the phone. The passport, loyalty programs, sharing with engagements and the access log open in Gateway.
 * Uniform sizes and travel preferences are asked per project since R6a (2664, ADR 0071 amendment): a notice says so,
 * and Project details holds them. The Profile keeps showing the contacts read-only (WorkDetailsCards).
 */
import type { XosClient } from "@xos/data";
import type { Result } from "@xos/data/result";
import {
  ACCESSIBILITY_NEEDS,
  addEmergencyContact,
  DIETARY_NEEDS,
  getMyWorkDetails,
  listMyEmergencyContacts,
  removeEmergencyContact,
  saveMyWorkDetails,
  workDetailLabelKey,
  type EmergencyContact,
  type WorkDetails,
  type WorkDetailsPatch,
} from "@xos/data/work-details";
import {
  parseAccessibilityForm,
  parseContactForm,
  parseDietaryForm,
  type Parsed,
} from "@xos/data/work-details-forms";
import { formatPhone, regionFromLocale, toE164 } from "@xos/i18n/formats";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../../runtime/CompassProvider";
import {
  fieldErrorKeys,
  formFields,
  MAX_CONTACTS,
  NEW_CONTACT,
  nextSortOrder,
  saveErrorKey,
  toggled,
} from "../../settings/workDetails";
import { Button, Card, InlineAlert, ListRow, Switch, Text, TextField } from "../../ui";
import { RegistrySettingsScreen } from "./RegistrySettings";

const W = "workDetails";

type SaveState =
  | { readonly kind: "idle" | "saving" | "saved" }
  | { readonly kind: "failed"; readonly key: string };

/** A save that needs the server's answer: saving, saved, or refused with its sentence. */
function useOnlineSave(onSaved: () => void) {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const run = async (save: () => Promise<Result<unknown>>) => {
    setState({ kind: "saving" });
    const result = await save();
    if (!result.ok) {
      setState({ kind: "failed", key: saveErrorKey(result.error) });
      return;
    }
    setState({ kind: "saved" });
    onSaved();
  };
  return { state, run };
}

function SaveNotice({ state, testID }: { readonly state: SaveState; readonly testID: string }) {
  const { t } = useTranslation();
  if (state.kind === "saved")
    return <InlineAlert testID={`${testID}-saved`} tone="success" message={t(`${W}.saved`)} />;
  if (state.kind === "failed")
    return <InlineAlert testID={`${testID}-failed`} tone="danger" message={t(state.key)} />;
  return null;
}

/** The field errors of a parse, translated; empty when it passed. */
function useFieldErrors() {
  const { t } = useTranslation();
  const [errors, setErrors] = useState<Record<string, string>>({});
  return {
    take: (parsed: Parsed<unknown>) => setErrors(fieldErrorKeys(parsed)),
    of: (field: string) => (errors[field] ? { error: t(errors[field]) } : {}),
  };
}

interface FormProps {
  readonly db: XosClient;
  readonly details: WorkDetails | null;
  readonly onSaved: () => void;
}

/** Saves a parsed Work Details patch, or shows what to fix. */
function usePatchSave(db: XosClient, onSaved: () => void) {
  const save = useOnlineSave(onSaved);
  const errors = useFieldErrors();
  const submit = (parsed: Parsed<WorkDetailsPatch>) => {
    errors.take(parsed);
    if (parsed.ok) void save.run(() => saveMyWorkDetails(db, parsed.value));
  };
  return { state: save.state, errors, submit };
}

/** Dietary or accessibility needs: one switch per need, then the notes. */
function NeedsCard({
  kind,
  db,
  details,
  onSaved,
}: FormProps & { readonly kind: "dietary" | "accessibility" }): ReactElement {
  const { t } = useTranslation();
  const dietary = kind === "dietary";
  const options: readonly string[] = dietary ? DIETARY_NEEDS : ACCESSIBILITY_NEEDS;
  const listName = dietary ? "dietaryNeeds" : "accessibilityNeeds";
  const [chosen, setChosen] = useState<readonly string[]>(
    (dietary ? details?.dietaryNeeds : details?.accessibilityNeeds) ?? [],
  );
  const [notes, setNotes] = useState<Record<string, string>>(
    dietary
      ? { allergies: details?.allergies ?? "", dietaryNotes: details?.dietaryNotes ?? "" }
      : { accessibilityNotes: details?.accessibilityNotes ?? "" },
  );
  const patch = usePatchSave(db, onSaved);
  const note = (name: string, label: string, help?: string) => (
    <TextField
      testID={`work-${kind}-${name}`}
      label={label}
      {...(help ? { help } : {})}
      value={notes[name] ?? ""}
      onChangeText={(value) => setNotes((n) => ({ ...n, [name]: value }))}
      multiline
      autoComplete="off"
      {...patch.errors.of(name)}
    />
  );
  return (
    <Card title={t(`${W}.${kind}.title`)} testID={`work-${kind}`}>
      <Text variant="text13" tone="secondary">
        {t(`${W}.${kind}.description`)}
      </Text>
      <Text variant="label13" tone="secondary">
        {t(`${W}.${kind}.needs`)}
      </Text>
      {options.map((need) => (
        <Switch
          key={need}
          testID={`work-${kind}-${workDetailLabelKey(need)}`}
          label={t(`${W}.${listName}.${workDetailLabelKey(need)}`)}
          value={chosen.includes(need)}
          onChange={() => setChosen((list) => toggled(list, need))}
        />
      ))}
      {dietary ? (
        <>
          {note("allergies", t(`${W}.dietary.allergies`), t(`${W}.dietary.allergiesHelp`))}
          {note("dietaryNotes", t(`${W}.dietary.notes`))}
        </>
      ) : (
        note("accessibilityNotes", t(`${W}.accessibility.notes`))
      )}
      <Button
        testID={`work-${kind}-save`}
        label={t("compass.common.save")}
        loading={patch.state.kind === "saving"}
        onPress={() => {
          const form = formFields({ ...notes, [listName]: chosen });
          patch.submit(dietary ? parseDietaryForm(form) : parseAccessibilityForm(form));
        }}
      />
      <SaveNotice state={patch.state} testID={`work-${kind}`} />
    </Card>
  );
}

function ContactsCard({
  db,
  contacts,
  personId,
  onSaved,
}: {
  readonly db: XosClient;
  readonly contacts: readonly EmergencyContact[];
  readonly personId: string;
  readonly onSaved: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const region = regionFromLocale(i18n.language);
  const [form, setForm] = useState<Record<string, string>>({ ...NEW_CONTACT });
  const errors = useFieldErrors();
  const save = useOnlineSave(() => {
    setForm({ ...NEW_CONTACT });
    onSaved();
  });
  // Removing a contact keeps a new one half typed.
  const removal = useOnlineSave(onSaved);
  const set = (name: string) => (value: string) => setForm((f) => ({ ...f, [name]: value }));
  const field = (
    name: string,
    label: string,
    keyboard: "default" | "phone" | "email" = "default",
    help?: string,
  ) => (
    <TextField
      testID={`work-contact-${name}`}
      label={label}
      {...(help ? { help } : {})}
      value={form[name] ?? ""}
      onChangeText={set(name)}
      keyboard={keyboard}
      autoComplete="off"
      {...errors.of(name)}
    />
  );
  const add = () => {
    const parsed = parseContactForm(
      formFields({ ...form, sortOrder: String(nextSortOrder(contacts)) }),
      (input) => toE164(input, region),
    );
    errors.take(parsed);
    if (parsed.ok) void save.run(() => addEmergencyContact(db, personId, parsed.value));
  };
  return (
    <Card title={t(`${W}.contacts.title`)} testID="work-contacts">
      <Text variant="text13" tone="secondary">
        {t(`${W}.contacts.description`)}
      </Text>
      {contacts.length === 0 ? <Text tone="tertiary">{t(`${W}.contacts.none`)}</Text> : null}
      {contacts.map((c, index) => (
        <ListRow
          key={c.id}
          testID={`work-contact-row-${index + 1}`}
          icon="user"
          title={c.relationship ? `${c.fullName} · ${c.relationship}` : c.fullName}
          subtitle={`${t(`${W}.contacts.order`, { position: index + 1 })} · ${formatPhone(c.phoneE164, region)}`}
          swipeEnd={{
            label: t(`${W}.removeNamed`, { name: c.fullName }),
            icon: "trash-2",
            tone: "danger",
            onAction: () => void removal.run(() => removeEmergencyContact(db, c.id)),
          }}
        />
      ))}
      {contacts.length < MAX_CONTACTS ? (
        <>
          <Text variant="heading16">{t(`${W}.contacts.add`)}</Text>
          {field("fullName", t(`${W}.contacts.name`))}
          {field("relationship", t(`${W}.contacts.relationship`))}
          {field(
            "phone",
            t(`${W}.contacts.phone`),
            "phone",
            t(`${W}.contacts.phoneHelp`, { region: region ?? "US" }),
          )}
          {field("alternatePhone", t(`${W}.contacts.alternatePhone`), "phone")}
          {field("email", t(`${W}.contacts.email`), "email")}
          <Button
            testID="work-contact-add"
            label={t(`${W}.contacts.add`)}
            icon="user"
            loading={save.state.kind === "saving"}
            onPress={add}
          />
        </>
      ) : null}
      <SaveNotice state={save.state} testID="work-contacts" />
      <SaveNotice state={removal.state} testID="work-contacts-removal" />
    </Card>
  );
}

interface Loaded {
  readonly details: WorkDetails | null;
  readonly contacts: readonly EmergencyContact[];
}

export function WorkDetailsSettings(): ReactElement {
  const { t } = useTranslation();
  const { client, network, resolved, config } = useCompass();
  const db = client as unknown as XosClient;
  const online = network.isConnected;
  const personId = resolved?.identity.personId ?? null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!online) return undefined;
    let live = true;
    void Promise.all([getMyWorkDetails(db), listMyEmergencyContacts(db)]).then(
      ([details, contacts]) => {
        if (!live) return;
        if (!details.ok || !contacts.ok) {
          setFailed(true);
          return;
        }
        setFailed(false);
        setLoaded({ details: details.data, contacts: contacts.data });
      },
    );
    return () => {
      live = false;
    };
  }, [db, online, attempt]);

  return (
    <RegistrySettingsScreen
      section="settings.work-details"
      title={t("nav.settings.personal.workDetails")}
      testID="settings-work-details"
    >
      {!online ? (
        <InlineAlert
          testID="work-details-offline"
          tone="info"
          message={t("compassPersonal.workDetails.offline")}
        />
      ) : failed ? (
        <InlineAlert
          testID="work-details-failed"
          tone="danger"
          message={t("compassPersonal.loadFailed")}
        />
      ) : !loaded ? (
        <Text tone="tertiary">{t("compass.common.loading")}</Text>
      ) : (
        <>
          <InlineAlert testID="work-details-moved" tone="info" message={t(`${W}.notice.body`)} />
          {/* Each form starts from what the server held when the section opened and keeps what was saved. */}
          <NeedsCard kind="dietary" db={db} details={loaded.details} onSaved={reload} />
          <NeedsCard kind="accessibility" db={db} details={loaded.details} onSaved={reload} />
          {personId ? (
            <ContactsCard db={db} contacts={loaded.contacts} personId={personId} onSaved={reload} />
          ) : null}
        </>
      )}
      <Card title={t("compassPersonal.workDetails.webTitle")} testID="work-details-web">
        <Text tone="secondary">{t("compassPersonal.workDetails.webHelp")}</Text>
        <Button
          testID="work-details-open-web"
          label={t("compass.common.openGateway")}
          icon="external-link"
          variant="secondary"
          onPress={() => void Linking.openURL(`${config.gatewayUrl}/settings/work-details`)}
        />
      </Card>
    </RegistrySettingsScreen>
  );
}
