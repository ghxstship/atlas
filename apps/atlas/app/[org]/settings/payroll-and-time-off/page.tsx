import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.payroll-and-time-off: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/payroll-and-time-off">) {
  return <SettingsSectionPage node="settings.payroll-and-time-off" params={await params} />;
}
