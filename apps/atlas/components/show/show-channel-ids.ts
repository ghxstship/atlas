/**
 * The show channel composer's element id (B3, ADR 0142). runs.tsx imports it without loading the panel, so the
 * showcaller console can hand show.chat (M) to the message box once the panel has loaded.
 */
export function showChannelComposerId(projectId: string): string {
  return `show-channel-composer-${projectId}`;
}
