import { Input } from "@xos/ui";
import type { AddressFormat, AddressInput, AddressValue } from "@/lib/address";

const AUTOCOMPLETE: Readonly<Record<AddressInput, string>> = {
  streetAddress: "street-address",
  locality: "address-level2",
  administrativeArea: "address-level1",
  postalCode: "postal-code",
};

/**
 * The address fields of a form in the country's order (Section 15, A139). The server computes `format`
 * (lib/address.ts), so this renders inputs only and carries no address metadata. Each field posts under
 * its own name: streetAddress, locality, administrativeArea, postalCode.
 */
export function AddressInputs({
  idPrefix,
  format,
  values,
  labels,
  error,
}: {
  idPrefix: string;
  format: AddressFormat;
  values?: AddressValue | null;
  labels: Readonly<Record<AddressInput, string>>;
  error?: (field: AddressInput) => string | undefined;
}) {
  return (
    <>
      {format.rows.map((row) => (
        <div key={row.join("-")} className="flex flex-wrap gap-12">
          {row.map((field) => (
            <Input
              key={field}
              id={`${idPrefix}-${field}`}
              name={field}
              label={labels[field]}
              autoComplete={AUTOCOMPLETE[field]}
              required={format.required.includes(field)}
              defaultValue={values?.[field] ?? ""}
              maxLength={field === "postalCode" ? 12 : field === "streetAddress" ? 200 : 100}
              {...(field === "streetAddress" ? { width: "100%" as const } : {})}
              error={error?.(field) ?? ""}
            />
          ))}
        </div>
      ))}
    </>
  );
}
