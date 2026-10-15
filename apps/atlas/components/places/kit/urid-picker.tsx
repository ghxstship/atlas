"use client";

import { Combobox } from "@xos/ui";
import { useState } from "react";

/**
 * A searchable picker for canon URID categories that posts its value with a form. Codes always sit
 * next to their plain name (Section 11.10, rule 2), so the label reads "Scenic Fabrication 4000.01.01".
 */
export function UridPicker({
  id,
  name,
  label,
  help,
  noMatch,
  value,
  categories,
}: {
  id: string;
  name: string;
  label: string;
  help?: string;
  noMatch: string;
  value: string | null;
  categories: readonly { urid: string; name: string }[];
}) {
  const [current, setCurrent] = useState(value ?? "");
  return (
    <div className="flex flex-col gap-4">
      <Combobox
        id={id}
        label={label}
        {...(help ? { help } : {})}
        noMatch={noMatch}
        value={current}
        options={categories.map((c) => ({ value: c.urid, label: `${c.name} ${c.urid}` }))}
        onChange={setCurrent}
      />
      <input type="hidden" name={name} value={current} />
    </div>
  );
}
