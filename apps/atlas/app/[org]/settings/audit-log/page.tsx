import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.audit-log: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/audit-log">) {
  return <SettingsSectionPage node="settings.audit-log" params={await params} />;
}
