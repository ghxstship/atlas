import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.approval-policies: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/approval-policies">) {
  return <SettingsSectionPage node="settings.approval-policies" params={await params} />;
}
