import { SettingsSectionPage } from "@/components/settings/settings-page";

/** me.accessibility: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/me/accessibility">) {
  return <SettingsSectionPage node="me.accessibility" params={await params} />;
}
