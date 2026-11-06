"use client";

import { Input, MultiSelect } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { ReasonField } from "@/components/fields";
import type { ConsoleT } from "@/lib/format";
import { saveTerritoryAction } from "@/lib/actions/territories";

type Option = { readonly value: string; readonly label: string };

/** What a territory holds now, which an edit starts from: saving replaces its lists. */
export interface EditedTerritory {
  readonly code: string;
  readonly nameEn: string;
  readonly nameEs: string;
  readonly countries: readonly string[];
  readonly currencies: readonly string[];
  readonly locales: readonly string[];
}

/**
 * Adds a territory, closed, or edits one from what it holds now. `version` changes once a save reaches the page, so the
 * fields start again from the saved territory, or empty after an add, while the form keeps its confirmation.
 */
export function TerritoryForm({
  countries,
  currencies,
  locales,
  territory,
  version,
}: {
  countries: readonly Option[];
  currencies: readonly Option[];
  locales: readonly Option[];
  territory: EditedTerritory | null;
  version: string;
}) {
  const t = useTranslations("console");
  return (
    <ActionForm
      action={saveTerritoryAction}
      hidden={territory ? { editing: territory.code } : {}}
      submitLabel={t("territories.save")}
      successLabel={t("territories.saved")}
      label={territory ? t("territories.editTitle", { code: territory.code }) : t("territories.add")}
      variant="secondary"
      testId="territory-form"
    >
      <TerritoryFields
        key={version}
        countries={countries}
        currencies={currencies}
        locales={locales}
        territory={territory}
      />
    </ActionForm>
  );
}

/** The picks go to the action as one comma-separated field each, since a MultiSelect holds no form value of its own. */
function TerritoryFields({
  countries,
  currencies,
  locales,
  territory,
}: {
  countries: readonly Option[];
  currencies: readonly Option[];
  locales: readonly Option[];
  territory: EditedTerritory | null;
}) {
  const t = useTranslations("console");
  const [pickedCountries, setCountries] = useState<string[]>([...(territory?.countries ?? [])]);
  const [pickedCurrencies, setCurrencies] = useState<string[]>([...(territory?.currencies ?? [])]);
  const [pickedLocales, setLocales] = useState<string[]>([...(territory?.locales ?? [])]);
  return (
    <>
      <input type="hidden" name="countries" value={pickedCountries.join(",")} />
      <input type="hidden" name="currencies" value={pickedCurrencies.join(",")} />
      <input type="hidden" name="locales" value={pickedLocales.join(",")} />
      <Input
        id="territory-code"
        name="code"
        label={t("territories.code")}
        help={territory ? t("territories.codeFixed") : t("territories.codeHelp")}
        required
        maxLength={8}
        {...(territory ? { defaultValue: territory.code, readOnly: true } : {})}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="territory-name-en"
          name="nameEn"
          label={t("territories.nameEn")}
          help={t("territories.nameHelp")}
          required
          maxLength={100}
          {...(territory ? { defaultValue: territory.nameEn } : {})}
        />
        <Input
          id="territory-name-es"
          name="nameEs"
          label={t("territories.nameEs")}
          required
          maxLength={100}
          {...(territory ? { defaultValue: territory.nameEs } : {})}
        />
      </div>
      <MultiSelect
        id="territory-countries"
        label={t("territories.countries")}
        value={pickedCountries}
        options={[...countries]}
        onChange={setCountries}
      />
      <MultiSelect
        id="territory-currencies"
        label={t("territories.currencies")}
        help={t("territories.currenciesHelp")}
        value={pickedCurrencies}
        options={[...currencies]}
        onChange={setCurrencies}
      />
      <MultiSelect
        id="territory-locales"
        label={t("territories.languages")}
        value={pickedLocales}
        options={[...locales]}
        onChange={setLocales}
      />
      <ReasonField t={t as unknown as ConsoleT} id="territory-reason" />
    </>
  );
}
