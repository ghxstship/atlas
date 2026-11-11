/**
 * Choosing from a list in a sheet (A111): a setting with more choices than fit as segments (the language, the
 * persona), the digest time and the time zone. Each row reads as a radio button, checked when it is the value.
 */
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { knownZones, matchZones, zoneLabel } from "../../settings/zones";
import { Icon, ListRow, Sheet, Text, TextField, useTheme } from "../../ui";

export interface Choice {
  readonly value: string;
  readonly label: string;
}

/** One choice: its label, and a check when it is the value. */
function OptionRow({
  choice,
  checked,
  onPress,
  testID,
}: {
  readonly choice: Choice;
  readonly checked: boolean;
  readonly onPress: () => void;
  readonly testID: string;
}): ReactElement {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      accessibilityLabel={choice.label}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space["12"],
        minHeight: theme.density.touchMin + theme.space["8"],
        borderBottomWidth: theme.strokeWidth.hairline,
        borderBottomColor: theme.color.borderSubtle,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text>{choice.label}</Text>
      </View>
      {checked ? <Icon name="check" tone="accent" /> : null}
    </Pressable>
  );
}

/** A sheet of choices; choosing one closes it. */
export function ChoiceSheet({
  open,
  title,
  value,
  choices,
  onChoose,
  onClose,
  testID,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly value: string;
  readonly choices: readonly Choice[];
  readonly onChoose: (value: string) => void;
  readonly onClose: () => void;
  readonly testID: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Sheet
      testID={testID}
      open={open}
      title={title}
      closeLabel={t("compass.common.close")}
      onClose={onClose}
    >
      <View accessibilityRole="radiogroup" accessibilityLabel={title}>
        {choices.map((choice) => (
          <OptionRow
            key={choice.value}
            testID={`${testID}-${choice.value}`}
            choice={choice}
            checked={choice.value === value}
            onPress={() => {
              onChoose(choice.value);
              onClose();
            }}
          />
        ))}
      </View>
    </Sheet>
  );
}

/** A row that shows a choice's current value and opens its sheet; a locked one only shows it. */
export function ChoiceRow({
  title,
  value,
  disabled,
  onPress,
  testID,
}: {
  readonly title: string;
  readonly value: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly testID: string;
}): ReactElement {
  return (
    <ListRow
      testID={testID}
      title={title}
      subtitle={value}
      {...(disabled ? {} : { onPress, trailing: <Icon name="chevron-right" tone="tertiary" /> })}
    />
  );
}

/**
 * The time zone picker: every zone the phone knows, searched by city or region, with the phone's own zone first.
 * A zone typed in full is offered even when the phone cannot list its zones.
 */
export function ZoneSheet({
  open,
  title,
  value,
  deviceZone,
  onChoose,
  onClose,
  testID,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly value: string;
  readonly deviceZone: string;
  readonly onChoose: (zone: string) => void;
  readonly onClose: () => void;
  readonly testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const zones = useMemo(() => knownZones(), []);
  const found = matchZones(query, zones, deviceZone);
  return (
    <Sheet
      testID={testID}
      open={open}
      title={title}
      closeLabel={t("compass.common.close")}
      onClose={() => {
        setQuery("");
        onClose();
      }}
    >
      <TextField
        testID={`${testID}-search`}
        label={t("compassPersonal.zones.search")}
        help={t("compassPersonal.zones.searchHelp")}
        value={query}
        onChangeText={setQuery}
        autoComplete="off"
      />
      {found.length === 0 ? (
        <Text tone="secondary">{t("compassPersonal.zones.none")}</Text>
      ) : (
        <View accessibilityRole="radiogroup" accessibilityLabel={title}>
          {found.map((zone) => (
            <OptionRow
              key={zone}
              testID={`${testID}-${zone}`}
              choice={{
                value: zone,
                label:
                  zone === deviceZone
                    ? t("compassPersonal.zones.device", { zone: zoneLabel(zone) })
                    : zoneLabel(zone),
              }}
              checked={zone === value}
              onPress={() => {
                setQuery("");
                onChoose(zone);
                onClose();
              }}
            />
          ))}
        </View>
      )}
    </Sheet>
  );
}
