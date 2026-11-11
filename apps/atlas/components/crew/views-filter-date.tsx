"use client";

import { Input } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useQueryHref } from "./views.shared";

/** A date filter that rewrites one query key; the page re-renders on the server with the new date. */
export function FilterDate(props: { name: string; label: string; value: string }) {
  const router = useRouter();
  const href = useQueryHref();
  return (
    <Input
      type="date"
      label={props.label}
      value={props.value}
      onChange={(e) => {
        if (e.target.value !== "") {
          router.replace(href({ [props.name]: e.target.value, peek: null }));
        }
      }}
    />
  );
}
