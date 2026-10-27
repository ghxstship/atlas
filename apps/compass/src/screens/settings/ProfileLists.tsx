/**
 * The lists on Settings, Profile (Section 4.5.6 item 1, Section 4.8.2): skills, languages, links and certifications,
 * each with its rows, Remove, and a form to add one. They are the person's own rows in app.person_*, kept on the
 * device; an addition or a removal queues offline (src/settings/writes.ts). Choosing a skill needs the canon category
 * list, which is read online.
 */
import type { Row } from "@xos/sync";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useCompass } from "../../runtime/CompassProvider";
import {
  checkCertification,
  checkLanguage,
  checkLink,
  checkSkill,
  PROFICIENCIES,
  type Checked,
} from "../../settings/forms";
import { readMyRows, readSkillCategories, type SkillCategory } from "../../settings/reads";
import {
  isLive,
  LIST_TABLE,
  listInsert,
  listRemove,
  MIRROR,
  type ProfileList,
} from "../../settings/writes";
import {
  Button,
  Card,
  InlineAlert,
  ListRow,
  Sheet,
  Skeleton,
  Tag,
  Text,
  TextField,
  useTheme,
} from "../../ui";
import { useMirror, useQueuedWrite, type QueuedWrite } from "./hooks";
import { LabeledChoice, OfflineNotice, WriteNotice } from "./parts";

/** Profile refusals with their own sentence (profiles.errors.*), such as a verified certification that stays. */
export function profileRuleKey(rule: string): string | undefined {
  return [
    "handle_format",
    "handle_reserved",
    "handle_taken",
    "handle_in_use",
    "handle_change_too_soon",
    "certification_verified_immutable",
    "certification_not_yours",
    "conflict",
  ].includes(rule)
    ? `profiles.errors.${rule === "conflict" ? "handle_in_use" : rule}`
    : undefined;
}

/** Remove's test id on each list's rows (named in full, so the Maestro flows find them). */
const REMOVE_ID: Readonly<Record<ProfileList, string>> = {
  skills: "settings-profile-skills-remove",
  languages: "settings-profile-languages-remove",
  links: "settings-profile-links-remove",
  certifications: "settings-profile-certifications-remove",
};

/** The first field error of a failed check, translated. */
function firstError(t: (key: string) => string, checked: Checked<unknown>): string | null {
  return checked.ok ? null : t(Object.values(checked.errors)[0] ?? "profiles.errors.invalid");
}

/** One list: the device rows with Remove, an empty sentence, the add form and the answer to the last change. */
function ListCard({
  list,
  personId,
  title,
  empty,
  rowTitle,
  rowSubtitle,
  rowTag,
  write,
  children,
}: {
  readonly list: ProfileList;
  readonly personId: string;
  readonly title: string;
  readonly empty: string;
  readonly rowTitle: (row: Row) => string;
  readonly rowSubtitle?: (row: Row) => string | undefined;
  readonly rowTag?: (row: Row) => ReactElement | undefined;
  readonly write: QueuedWrite;
  readonly children: ReactElement;
}): ReactElement {
  const { t } = useTranslation();
  const { client } = useCompass();
  const read = useCallback(
    () => readMyRows(client, LIST_TABLE[list], personId),
    [client, list, personId],
  );
  const mirror = useMirror<Row>(MIRROR[list], read, isLive);
  const testID = `settings-profile-${list}`;
  return (
    <Card testID={testID} title={title}>
      {!mirror.ready ? (
        mirror.notLoaded ? (
          <OfflineNotice kind="first" testID={`${testID}-first`} />
        ) : (
          <Skeleton testID={`${testID}-loading`} lines={2} />
        )
      ) : mirror.rows.length === 0 ? (
        <Text tone="secondary">{empty}</Text>
      ) : (
        mirror.rows
          .slice()
          .sort((a, b) => rowTitle(a).localeCompare(rowTitle(b)))
          .map((row) => {
            const name = rowTitle(row);
            const subtitle = rowSubtitle?.(row);
            return (
              <ListRow
                key={row.id}
                testID={`${testID}-row`}
                title={name}
                {...(subtitle ? { subtitle } : {})}
                trailing={
                  <View style={{ alignItems: "flex-end" }}>
                    {rowTag?.(row)}
                    <Button
                      testID={REMOVE_ID[list]}
                      variant="ghost"
                      label={t("profiles.remove")}
                      onPress={() =>
                        void write.save(listRemove(list, row, new Date().toISOString()))
                      }
                    />
                  </View>
                }
              />
            );
          })
      )}
      {mirror.failed ? (
        <InlineAlert tone="warning" message={t("compassSettings.common.loadFailed")} />
      ) : null}
      {children}
      <WriteNotice state={write.state} ruleKey={profileRuleKey} testID={testID} />
    </Card>
  );
}

function SkillsCard({ personId }: { readonly personId: string }): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { client, network } = useCompass();
  const write = useQueuedWrite();
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [categories, setCategories] = useState<readonly SkillCategory[] | null | "failed">(null);
  // The canon names of the person's skills, and the list to choose from; read online, once per visit.
  useEffect(() => {
    if (categories !== null || !network.isConnected) return undefined;
    let current = true;
    void readSkillCategories(client).then((found) => {
      if (current) setCategories(found ?? "failed");
    });
    return () => {
      current = false;
    };
  }, [categories, client, network.isConnected]);
  const names = useMemo(
    () =>
      new Map(
        (Array.isArray(categories) ? categories : []).map((c) => [c.catUrid, c.category] as const),
      ),
    [categories],
  );
  const matches = useMemo(() => {
    if (!Array.isArray(categories)) return [];
    const q = query.trim().toLowerCase();
    return categories
      .filter((c) => q === "" || c.category.toLowerCase().includes(q) || c.catUrid.startsWith(q))
      .slice(0, 50);
  }, [categories, query]);
  const add = (catUrid: string) => {
    const checked = checkSkill(catUrid);
    if (!checked.ok) return;
    setPicking(false);
    setQuery("");
    void write.save(
      listInsert("skills", personId, { ...checked.value, sort_order: 0 }, Date.now()),
    );
  };
  return (
    <ListCard
      list="skills"
      personId={personId}
      title={t("profiles.skills.title")}
      empty={t("profiles.skills.none")}
      rowTitle={(row) => names.get(String(row["cat_urid"])) ?? String(row["cat_urid"] ?? "")}
      rowSubtitle={(row) =>
        names.has(String(row["cat_urid"])) ? String(row["cat_urid"]) : undefined
      }
      write={write}
    >
      <>
        <Button
          testID="settings-profile-skills-add"
          variant="secondary"
          icon="plus"
          label={t("profiles.skills.add")}
          disabled={!network.isConnected}
          onPress={() => setPicking(true)}
        />
        {!network.isConnected ? (
          <Text variant="text13" tone="tertiary">
            {t("compassSettings.profile.skillsOffline")}
          </Text>
        ) : null}
        <Sheet
          testID="settings-profile-skills-picker"
          open={picking}
          title={t("profiles.skills.add")}
          closeLabel={t("compass.common.close")}
          onClose={() => setPicking(false)}
        >
          <View style={{ gap: theme.space["12"] }}>
            <TextField
              testID="settings-profile-skills-search"
              label={t("compassSettings.profile.searchSkills")}
              value={query}
              onChangeText={setQuery}
              autoComplete="off"
            />
            {categories === null ? (
              <Skeleton lines={3} />
            ) : categories === "failed" ? (
              <InlineAlert tone="danger" message={t("compassSettings.common.loadFailed")} />
            ) : matches.length === 0 ? (
              <Text tone="secondary">
                {t("compassSettings.profile.noSkillMatch", { query: query.trim() })}
              </Text>
            ) : (
              matches.map((c) => (
                <ListRow
                  key={c.catUrid}
                  testID="settings-profile-skills-option"
                  title={c.category}
                  subtitle={c.catUrid}
                  onPress={() => add(c.catUrid)}
                />
              ))
            )}
          </View>
        </Sheet>
      </>
    </ListCard>
  );
}

function LanguagesCard({ personId }: { readonly personId: string }): ReactElement {
  const { t } = useTranslation();
  const write = useQueuedWrite();
  const [tag, setTag] = useState("");
  const [proficiency, setProficiency] = useState<string>("Fluent");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const checked = checkLanguage(tag, proficiency);
    setError(firstError(t, checked));
    if (!checked.ok) return;
    setTag("");
    void write.save(listInsert("languages", personId, checked.value, Date.now()));
  };
  return (
    <ListCard
      list="languages"
      personId={personId}
      title={t("profiles.languages.title")}
      empty={t("profiles.languages.none")}
      rowTitle={(row) => String(row["language_tag"] ?? "")}
      rowSubtitle={(row) => t(`profiles.proficiency.${String(row["proficiency"] ?? "Fluent")}`)}
      write={write}
    >
      <>
        <TextField
          testID="settings-profile-languages-tag"
          label={t("profiles.languages.tag")}
          help={t("profiles.languages.tagHelp")}
          value={tag}
          onChangeText={setTag}
          autoComplete="off"
          {...(error ? { error } : {})}
        />
        <LabeledChoice
          testID="settings-profile-languages-proficiency"
          label={t("profiles.languages.proficiency")}
          value={proficiency}
          options={PROFICIENCIES.map((p) => ({ value: p, label: t(`profiles.proficiency.${p}`) }))}
          onChange={setProficiency}
        />
        <Button
          testID="settings-profile-languages-add"
          variant="secondary"
          icon="plus"
          label={t("profiles.languages.add")}
          onPress={add}
        />
      </>
    </ListCard>
  );
}

function LinksCard({ personId }: { readonly personId: string }): ReactElement {
  const { t } = useTranslation();
  const write = useQueuedWrite();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("https://");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const checked = checkLink(label, url);
    setError(firstError(t, checked));
    if (!checked.ok) return;
    setLabel("");
    setUrl("https://");
    void write.save(listInsert("links", personId, { ...checked.value, sort_order: 0 }, Date.now()));
  };
  return (
    <ListCard
      list="links"
      personId={personId}
      title={t("profiles.links.title")}
      empty={t("profiles.links.none")}
      rowTitle={(row) => String(row["label"] ?? "")}
      rowSubtitle={(row) => String(row["url"] ?? "")}
      write={write}
    >
      <>
        <TextField
          testID="settings-profile-links-label"
          label={t("profiles.links.label")}
          value={label}
          onChangeText={setLabel}
        />
        <TextField
          testID="settings-profile-links-url"
          label={t("profiles.links.url")}
          help={t("profiles.links.urlHelp")}
          keyboard="url"
          value={url}
          onChangeText={setUrl}
          {...(error ? { error } : {})}
        />
        <Button
          testID="settings-profile-links-add"
          variant="secondary"
          icon="plus"
          label={t("profiles.links.add")}
          onPress={add}
        />
      </>
    </ListCard>
  );
}

function CertificationsCard({ personId }: { readonly personId: string }): ReactElement {
  const { t } = useTranslation();
  const write = useQueuedWrite();
  const [name, setName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const checked = checkCertification({ name, issuingBody: issuer, issuedOn, expiresOn });
    setError(firstError(t, checked));
    if (!checked.ok) return;
    setName("");
    setIssuer("");
    setIssuedOn("");
    setExpiresOn("");
    void write.save(listInsert("certifications", personId, checked.value, Date.now()));
  };
  return (
    <ListCard
      list="certifications"
      personId={personId}
      title={t("profiles.certifications.title")}
      empty={t("profiles.certifications.none")}
      rowTitle={(row) => String(row["name"] ?? "")}
      rowSubtitle={(row) =>
        [
          String(row["issuing_body"] ?? ""),
          row["expires_on"]
            ? t("profiles.certifications.expires", { date: String(row["expires_on"]) })
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      }
      rowTag={(row) => (
        <Tag
          tone={row["verified_at"] ? "success" : "neutral"}
          label={t(
            row["verified_at"]
              ? "profiles.certifications.verified"
              : "profiles.certifications.unverified",
          )}
        />
      )}
      write={write}
    >
      <>
        <TextField
          testID="settings-profile-certifications-name"
          label={t("profiles.certifications.name")}
          value={name}
          onChangeText={setName}
        />
        <TextField
          testID="settings-profile-certifications-issuer"
          label={t("profiles.certifications.issuer")}
          value={issuer}
          onChangeText={setIssuer}
        />
        <TextField
          testID="settings-profile-certifications-issued"
          label={t("profiles.certifications.issuedOn")}
          help={t("compassSettings.profile.dateHelp")}
          value={issuedOn}
          onChangeText={setIssuedOn}
          autoComplete="off"
        />
        <TextField
          testID="settings-profile-certifications-expires"
          label={t("profiles.certifications.expiresOn")}
          help={t("compassSettings.profile.expiresHelp")}
          value={expiresOn}
          onChangeText={setExpiresOn}
          autoComplete="off"
          {...(error ? { error } : {})}
        />
        <Button
          testID="settings-profile-certifications-add"
          variant="secondary"
          icon="plus"
          label={t("profiles.certifications.add")}
          onPress={add}
        />
      </>
    </ListCard>
  );
}

/** The four lists of the profile, in Gateway's order. */
export function ProfileLists({ personId }: { readonly personId: string }): ReactElement {
  return (
    <>
      <SkillsCard personId={personId} />
      <CertificationsCard personId={personId} />
      <LanguagesCard personId={personId} />
      <LinksCard personId={personId} />
    </>
  );
}
