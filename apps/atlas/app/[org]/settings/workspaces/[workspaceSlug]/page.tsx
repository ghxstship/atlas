import { WorkspaceSettingsPage } from "@/components/settings/surfaces/scopes";

/** settings.workspaces.workspace: one workspace's settings (ADR 0006 amendment of 2026-10-21). */
export default async function Page({
  params,
}: PageProps<"/[org]/settings/workspaces/[workspaceSlug]">) {
  return <WorkspaceSettingsPage params={await params} />;
}
