"use client";

import { usePathname } from "next/navigation";
import { SectionTabs } from "@/components/page/section-tabs";

/** The engagement's top tabs; the tab for the current path is marked current. */
export function EngagementTabNav({
  label,
  tabs,
}: {
  label: string;
  tabs: readonly { readonly id: string; readonly label: string; readonly href: string }[];
}) {
  const pathname = usePathname();
  const active =
    tabs.find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))?.id ?? "";
  return <SectionTabs label={label} tabs={tabs} active={active} />;
}
