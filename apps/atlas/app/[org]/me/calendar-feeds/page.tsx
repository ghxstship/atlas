import { SettingsSectionPage } from "@/components/settings/settings-page";

/** me.calendar-feeds: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/me/calendar-feeds">) {
  return <SettingsSectionPage node="me.calendar-feeds" params={await params} />;
}
