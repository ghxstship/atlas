"use client";

import { Select } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * The scope picker in the project header (Section 4.5.1): filters every project tab to one node of
 * the scope tree through the `scope` query parameter, which every list route accepts (4.5.3).
 */
export function ScopePicker({
  label,
  allLabel,
  nodes,
}: {
  label: string;
  allLabel: string;
  nodes: readonly { readonly code: string; readonly label: string; readonly depth: number }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get("scope") ?? "";
  return (
    <div className="w-full sm:w-auto">
      <Select
        key={current}
        id="project-scope"
        label={label}
        value={current}
        options={[
          { value: "", label: allLabel },
          ...nodes.map((n) => ({
            value: n.code,
            label: `${"  ".repeat(n.depth)}${n.label}`,
          })),
        ]}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString());
          if (e.target.value) next.set("scope", e.target.value);
          else next.delete("scope");
          const query = next.toString();
          router.replace((query ? `${pathname}?${query}` : pathname) as Route);
        }}
      />
    </div>
  );
}
