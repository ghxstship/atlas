import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useCompass } from "../../src/runtime/CompassProvider";
import { facts, GatewayStep, useMediumDate } from "../../src/screens/settings/ConnectionParts";
import { useMirror, useQueuedWrite } from "../../src/screens/settings/hooks";
import { OfflineNotice, WriteNotice } from "../../src/screens/settings/parts";
import {
  addressInput,
  addressStanding,
  checkTaxAddress,
  enumLabel,
  giveTaxFormUrl,
  PAYOUT_TAX_MIRROR,
  payoutItems,
  readMyPayouts,
  readMyTaxForms,
  sameAddress,
  taxAddressRuleKey,
  taxAddressWrite,
  taxFormItems,
  type PayoutRow,
  type TaxAddressInput,
  type TaxFormRow,
} from "../../src/settings/payout-tax";
import {
  Button,
  Card,
  InlineAlert,
  ListRow,
  Screen,
  Sheet,
  Skeleton,
  Text,
  TextField,
  useTheme,
} from "../../src/ui";

const P = "compassSettings.payoutTax";

/** A list read from the server and kept on the device: its rows, or why there are none to show yet. */
function MirrorState({
  ready,
  notLoaded,
  failed,
  testID,
}: {
  readonly ready: boolean;
  readonly notLoaded: boolean;
  readonly failed: boolean;
  readonly testID: string;
}): ReactElement | null {
  const { t } = useTranslation();
  if (ready) return null;
  if (notLoaded) return <OfflineNotice kind="first" testID={`${testID}-first`} />;
  if (failed)
    return (
      <InlineAlert
        testID={`${testID}-failed`}
        tone="danger"
        message={t("compassSettings.common.loadFailed")}
      />
    );
  return <Skeleton testID={`${testID}-loading`} lines={2} />;
}

/** Where each org pays the person: provider and last four only. Payout details are entered at the provider. */
function Payouts({
  personId,
  forms,
}: {
  readonly personId: string;
  readonly forms: readonly TaxFormRow[];
}): ReactElement {
  const { t } = useTranslation();
  const { client, resolved } = useCompass();
  const read = useCallback(() => readMyPayouts(client, personId), [client, personId]);
  const mirror = useMirror<PayoutRow>(PAYOUT_TAX_MIRROR.payouts, read);
  const orgNames = useMemo(
    () => new Map((resolved?.contexts ?? []).map((c) => [c.orgId, c.orgName])),
    [resolved?.contexts],
  );
  const items = payoutItems(mirror.rows, orgNames, forms);
  return (
    <Card testID="settings-payouts" title={t("gateway.money.tax.payouts")}>
      <Text variant="text13" tone="tertiary">
        {t("gateway.settings.payout.body")}
      </Text>
      <MirrorState {...mirror} testID="settings-payouts" />
      {mirror.ready && items.length === 0 ? (
        <Text testID="settings-payouts-empty" tone="secondary">
          {t(`${P}.noPayouts`)}
        </Text>
      ) : null}
      {mirror.ready
        ? items.map((item) => (
            <ListRow
              key={item.id}
              testID="settings-payout"
              icon="banknote"
              title={t(item.providerKey)}
              subtitle={facts(
                item.orgName,
                item.last4 ? t("gateway.money.tax.last4", { last4: item.last4 }) : null,
              )}
            />
          ))
        : null}
    </Card>
  );
}

/** The W-9 name and mailing address, checked as Gateway checks it; the save queues offline. */
function AddressSheet({
  form,
  onSave,
  onClose,
}: {
  readonly form: TaxFormRow | null;
  readonly onSave: (form: TaxFormRow, input: TaxAddressInput) => Record<string, string> | null;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { network } = useCompass();
  const [input, setInput] = useState<TaxAddressInput | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const values = input ?? (form ? addressInput(form) : null);
  const field = (name: keyof TaxAddressInput) => ({
    value: values?.[name] ?? "",
    onChangeText: (value: string) => values && setInput({ ...values, [name]: value }),
    ...(errors[name] ? { error: t(errors[name]) } : {}),
  });
  const close = () => {
    setInput(null);
    setErrors({});
    onClose();
  };
  return (
    <Sheet
      testID="settings-tax-address"
      open={form !== null}
      title={t("payouts.w9.formTitle")}
      closeLabel={t("compass.common.close")}
      onClose={close}
    >
      <View style={{ gap: theme.space["12"] }}>
        {form ? (
          <Text tone="secondary">
            {facts(form.orgName, t("gateway.money.tax.last4", { last4: form.tinLast4 }))}
          </Text>
        ) : null}
        <Text variant="text13" tone="tertiary">
          {t(`${P}.addressHelp`)}
        </Text>
        {!network.isConnected ? (
          <OfflineNotice kind="queues" testID="settings-tax-offline" />
        ) : null}
        <TextField
          testID="settings-tax-legal-name"
          label={t("payouts.w9.legalName")}
          help={t("payouts.w9.legalNameHelp")}
          autoComplete="name"
          {...field("legalName")}
        />
        <TextField
          testID="settings-tax-street"
          label={t("payouts.w9.street")}
          {...field("streetAddress")}
        />
        <TextField
          testID="settings-tax-locality"
          label={t("payouts.w9.locality")}
          {...field("locality")}
        />
        <TextField
          testID="settings-tax-region"
          label={t("payouts.w9.region")}
          {...field("regionCode")}
        />
        <TextField
          testID="settings-tax-postal"
          label={t("payouts.w9.postal")}
          keyboard="numeric"
          {...field("postalCode")}
        />
        <Button
          testID="settings-tax-save"
          block
          label={t("payouts.w9.submit")}
          onPress={() => {
            if (!form || !values) return;
            const refused = onSave(form, values);
            if (refused) setErrors(refused);
            else close();
          }}
        />
      </View>
    </Sheet>
  );
}

/**
 * The tax forms the person gave each org, newest first: the form, the last four of the identifier, when it was
 * signed, foreign performer withholding, and for a W-9 whether the mailing address the 1099-NEC needs is there.
 */
function TaxForms({
  forms,
  mirror,
}: {
  readonly forms: readonly TaxFormRow[];
  readonly mirror: {
    readonly ready: boolean;
    readonly notLoaded: boolean;
    readonly failed: boolean;
  };
}): ReactElement {
  const { t } = useTranslation();
  const { config } = useCompass();
  const date = useMediumDate();
  const write = useQueuedWrite();
  const [editing, setEditing] = useState<TaxFormRow | null>(null);
  const save = (form: TaxFormRow, input: TaxAddressInput) => {
    const checked = checkTaxAddress(input);
    if (!checked.ok) return checked.errors;
    if (sameAddress(form, checked.value)) write.unchanged();
    else void write.save(taxAddressWrite(form, checked.value));
    return null;
  };
  return (
    <Card testID="settings-tax-forms" title={t("gateway.documents.tax")}>
      <Text variant="text13" tone="tertiary">
        {t("gateway.money.tax.yearEnd")}
      </Text>
      <MirrorState {...mirror} testID="settings-tax-forms" />
      {mirror.ready && forms.length === 0 ? (
        <Text testID="settings-tax-forms-empty" tone="secondary">
          {t("gateway.money.tax.empty")}
        </Text>
      ) : null}
      {mirror.ready
        ? taxFormItems(forms).map((form) => {
            const standing = addressStanding(form);
            return (
              <ListRow
                key={form.id}
                testID="settings-tax-form"
                icon="file-text"
                title={t(enumLabel("taxFormKind", form.kind))}
                subtitle={facts(
                  form.orgName,
                  t("gateway.money.tax.last4", { last4: form.tinLast4 }),
                  t(`${P}.signed`, { date: date(form.signedAt) }),
                  form.withholding ? t("gateway.money.tax.withholding") : null,
                  standing === "none" ? null : t(`${P}.address.${standing}`),
                )}
                trailing={
                  standing === "none" ? undefined : (
                    <Button
                      testID="settings-tax-address-edit"
                      variant={standing === "needed" ? "secondary" : "ghost"}
                      label={t(standing === "needed" ? `${P}.addAddress` : `${P}.editAddress`)}
                      onPress={() => {
                        write.reset();
                        setEditing(form);
                      }}
                    />
                  )
                }
              />
            );
          })
        : null}
      <WriteNotice state={write.state} ruleKey={taxAddressRuleKey} testID="settings-tax-address" />
      <GatewayStep
        testID="settings-tax-give"
        icon="file-text"
        title={t(`${P}.giveTaxForm`)}
        reason={t(`${P}.giveTaxFormReason`)}
        url={giveTaxFormUrl(config.gatewayUrl)}
      />
      <AddressSheet form={editing} onSave={save} onClose={() => setEditing(null)} />
    </Card>
  );
}

/**
 * Settings, Payout and Tax (sitemap settings.payout-and-tax; Section 4.5.6 item 11, ADR 0072): the payout
 * destinations and tax forms the person gave each org, read online and kept on the phone; the W-9 address saves on
 * the phone offline. Giving a tax form opens Gateway, from the engagement that asks for it.
 */
export default function PayoutAndTaxScreen(): ReactElement {
  const { t } = useTranslation();
  const { client, resolved } = useCompass();
  const personId = resolved?.identity.personId ?? null;
  const readForms = useCallback(
    () => (personId ? readMyTaxForms(client, personId) : Promise.resolve(null)),
    [client, personId],
  );
  const forms = useMirror<TaxFormRow>(PAYOUT_TAX_MIRROR.taxForms, personId ? readForms : null);
  return (
    <Screen testID="settings-payout-tax" title={t("nav.settings.personal.payoutAndTax")}>
      <Text tone="secondary">{t("gateway.settings.leads.payoutAndTax")}</Text>
      {personId ? <Payouts personId={personId} forms={forms.rows} /> : null}
      <TaxForms forms={forms.rows} mirror={forms} />
    </Screen>
  );
}
