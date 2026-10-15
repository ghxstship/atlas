import { SettingsSectionPage } from "@/components/settings/settings-page";

/** me.work-details: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/me/work-details">) {
  return <SettingsSectionPage node="me.work-details" params={await params} />;
}
