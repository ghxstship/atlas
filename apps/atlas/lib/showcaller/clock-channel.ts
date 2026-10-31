/**
 * The BroadcastChannel a showcaller portal feeds its pop-out clock through (B3, ADR 0142): named for the end of
 * the link's token, which never leaves this browser, so two links open side by side keep their clocks apart.
 */
export function clockChannelName(token: string): string {
  return `xos-showcaller-clock:${token.slice(-16)}`;
}
