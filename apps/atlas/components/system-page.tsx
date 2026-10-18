"use client";

import { TemplateSystem } from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";

/**
 * @xos/ui TemplateSystem whose one action navigates, for the not-found and legal pages. A boundary
 * file of its own, as the not-found boundaries are part of every route (ADR 0027).
 */
export function SystemPage(props: {
  icon: string;
  title: string;
  sentence: string;
  actionLabel: string;
  href: string;
}) {
  const router = useRouter();
  return (
    <TemplateSystem
      icon={props.icon}
      title={props.title}
      sentence={props.sentence}
      actionLabel={props.actionLabel}
      onAction={() => router.push(props.href as Route)}
    />
  );
}
