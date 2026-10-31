/**
 * The org switcher in the header and the org brand chip (Section 4.5.7 org switching, Section 12 Mobile).
 * The header always names the active org in its brand: its logo for the theme and its name. A person in
 * several orgs opens the switcher from it; each org in the list, and each group on the combined Today,
 * carries that org's brand chip. The switcher also holds the role lens (A128, Section 4.8.1): All roles, or one of
 * the person's roles in the active org, for this app session.
 */
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Image, Pressable, View } from "react-native";
import { chipColor, logoFor, logoUrl } from "../domain/brand";
import { useCompass } from "../runtime/CompassProvider";
import type { LensOption } from "../domain/roleLens";
import { ListRow, Sheet, Text, useTheme } from "../ui";

/** An org's brand mark: its logo when it has one, else a dot in its accent (neutral when the accent fails). */
export function BrandChip({
  orgId,
  name,
  testID,
}: {
  readonly orgId: string;
  readonly name: string;
  readonly testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { brands, config } = useCompass();
  const brand = brands.get(orgId);
  const label = brand?.name || name;
  const logo = logoUrl(config.supabaseUrl, logoFor(brand, theme.dark));
  const dot = chipColor(brand, theme.name) ?? theme.color.textSecondary;
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={t("compass.orgs.chip", { org: label })}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space["6"],
        alignSelf: "flex-start",
        paddingHorizontal: theme.space["8"],
        paddingVertical: theme.space["4"],
        borderRadius: theme.radius.chip,
        backgroundColor: theme.color.bgRaised,
      }}
    >
      {logo ? (
        <Image
          source={{ uri: logo }}
          accessibilityIgnoresInvertColors
          style={{ width: theme.iconSize["16"], height: theme.iconSize["16"] }}
          resizeMode="contain"
        />
      ) : (
        <View
          style={{
            width: theme.space["8"],
            height: theme.space["8"],
            borderRadius: theme.radius.pill,
            backgroundColor: dot,
          }}
        />
      )}
      <Text variant="label13" tone="primary">
        {label}
      </Text>
    </View>
  );
}

/**
 * The active org in the header. With one org and one role it is the brand mark alone; otherwise it opens the
 * switcher, where choosing an org makes its projects, brand and rules drive every screen, and choosing a role
 * narrows them to that role (the role lens).
 */
export function OrgSwitcher(): ReactElement | null {
  const { t } = useTranslation();
  const theme = useTheme();
  const { resolved, setOrgId, brands, lens, setLens } = useCompass();
  const [open, setOpen] = useState(false);
  if (!resolved?.orgId) return null;
  const active = resolved.contexts.find((c) => c.orgId === resolved.orgId);
  if (!active) return null;
  const name = (orgId: string, fallback: string) => brands.get(orgId)?.name || fallback;
  const chip = <BrandChip testID="org-current" orgId={active.orgId} name={active.orgName} />;
  const severalOrgs = resolved.contexts.length >= 2;
  if (!severalOrgs && lens.options.length === 0) return chip;
  const roleLabel = (o: LensOption) =>
    o.kind === "role-type"
      ? t(`compass.audience.${o.code}`)
      : (o.name ?? t(`compass.roleLens.roles.${o.code}`, { defaultValue: o.code }));
  const current = lens.options.find((o) => o.id === lens.current);
  const choose = (next: string | null) => {
    setLens(next);
    setOpen(false);
  };
  return (
    <>
      <Pressable
        testID="org-switcher"
        accessibilityRole="button"
        accessibilityLabel={
          current
            ? t("compass.roleLens.switch", {
                org: name(active.orgId, active.orgName),
                role: roleLabel(current),
              })
            : t("compass.orgs.switch", { org: name(active.orgId, active.orgName) })
        }
        accessibilityHint={t("compass.orgs.switchHint")}
        onPress={() => setOpen(true)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: theme.space["4"],
          minHeight: theme.density.touchMin,
        }}
      >
        {chip}
        {current ? (
          <Text testID="role-lens-current" variant="label13" tone="secondary">
            {roleLabel(current)}
          </Text>
        ) : null}
        <Text variant="label13" tone="accent">
          {t("compass.orgs.change")}
        </Text>
      </Pressable>
      <Sheet
        open={open}
        title={t("compass.orgs.title")}
        closeLabel={t("compass.common.close")}
        onClose={() => setOpen(false)}
      >
        {(severalOrgs ? resolved.contexts : []).map((c) => (
          <ListRow
            key={c.orgId}
            testID={`org-${c.orgId}`}
            title={name(c.orgId, c.orgName)}
            subtitle={t(c.kind === "member" ? "compass.orgs.member" : "compass.orgs.engaged")}
            icon={c.orgId === resolved.orgId ? "check" : "building-2"}
            trailing={<BrandChip orgId={c.orgId} name={c.orgName} />}
            onPress={() => {
              setOrgId(c.orgId);
              setOpen(false);
            }}
          />
        ))}
        {lens.options.length > 0 ? (
          <View testID="role-lens" style={{ gap: theme.space["4"], paddingTop: theme.space["12"] }}>
            <Text variant="label13" tone="primary" heading>
              {t("compass.roleLens.title")}
            </Text>
            <Text variant="text13" tone="secondary">
              {t("compass.roleLens.hint")}
            </Text>
            <ListRow
              testID="role-lens-all"
              title={t("compass.roleLens.all")}
              icon={lens.current === null ? "check" : "users"}
              onPress={() => choose(null)}
            />
            {lens.options.map((o) => (
              <ListRow
                key={o.id}
                testID={`role-lens-${o.id}`}
                title={roleLabel(o)}
                icon={lens.current === o.id ? "check" : "user"}
                onPress={() => choose(o.id)}
              />
            ))}
          </View>
        ) : null}
      </Sheet>
    </>
  );
}
