import { TeamSettingsPage } from "@/components/settings/surfaces/scopes";

/** settings.teams.team: one team's settings (ADR 0006 amendment of 2026-10-21). */
export default async function Page({ params }: PageProps<"/[org]/settings/teams/[teamId]">) {
  return <TeamSettingsPage params={await params} />;
}
