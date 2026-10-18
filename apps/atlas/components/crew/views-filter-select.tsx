"use client";

import { Select } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useQueryHref } from "./views.shared";

/** A filter that rewrites one query key; the page re-renders on the server with the new filter. */
export function FilterSelect(props: {
  name: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
}) {
  const router = useRouter();
  const href = useQueryHref();
  return (
    <Select
      label={props.label}
      value={props.value}
      options={props.options}
      onChange={(e) =>
        router.replace(
          href({ [props.name]: e.target.value === "" ? null : e.target.value, peek: null }),
        )
      }
    />
  );
}
