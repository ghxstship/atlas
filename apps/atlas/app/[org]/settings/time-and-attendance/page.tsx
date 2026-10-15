import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.time-and-attendance: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/time-and-attendance">) {
  return <SettingsSectionPage node="settings.time-and-attendance" params={await params} />;
}
