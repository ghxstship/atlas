"use client";

import { Input, MultiSelect } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { ReasonField } from "@/components/fields";
import type { ConsoleT } from "@/lib/format";
import { saveTerritoryAction } from "@/lib/actions/territories";

type Option = { readonly value: string; readonly label: string };

/**
 * Adds a territory, closed, or edits one by naming its code. The picks go to the action as one comma-separated field
 * each, since a MultiSelect holds no form value of its own.
 */
export function TerritoryForm({
  countries,
  currencies,
  locales,
}: {
  countries: readonly Option[];
  currencies: readonly Option[];
  locales: readonly Option[];
}) {
  const t = useTranslations("console");
  const [pickedCountries, setCountries] = useState<string[]>([]);
  const [pickedCurrencies, setCurrencies] = useState<string[]>([]);
  const [pickedLocales, setLocales] = useState<string[]>([]);
  return (
    <ActionForm
      action={saveTerritoryAction}
      hidden={{
        countries: pickedCountries.join(","),
        currencies: pickedCurrencies.join(","),
        locales: pickedLocales.join(","),
      }}
      submitLabel={t("territories.save")}
      successLabel={t("territories.saved")}
      label={t("territories.add")}
      testId="territory-form"
    >
      <Input
        id="territory-code"
        name="code"
        label={t("territories.code")}
        help={t("territories.codeHelp")}
        required
        maxLength={8}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="territory-name-en"
          name="nameEn"
          label={t("territories.nameEn")}
          help={t("territories.nameHelp")}
          required
          maxLength={100}
        />
        <Input
          id="territory-name-es"
          name="nameEs"
          label={t("territories.nameEs")}
          required
          maxLength={100}
        />
      </div>
      <MultiSelect
        id="territory-countries"
        label={t("territories.countries")}
        options={[...countries]}
        onChange={setCountries}
      />
      <MultiSelect
        id="territory-currencies"
        label={t("territories.currencies")}
        help={t("territories.currenciesHelp")}
        options={[...currencies]}
        onChange={setCurrencies}
      />
      <MultiSelect
        id="territory-locales"
        label={t("territories.languages")}
        options={[...locales]}
        onChange={setLocales}
      />
      <ReasonField t={t as unknown as ConsoleT} id="territory-reason" />
    </ActionForm>
  );
}
