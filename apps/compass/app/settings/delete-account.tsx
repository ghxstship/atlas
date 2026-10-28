import type { ReactElement } from "react";
import { DeleteAccount } from "../../src/screens/DeleteAccount";

/**
 * Delete Account (SIM-004, journey 38; App Store guideline 5.1.1(v)), opened from Settings and from Settings,
 * Account (sitemap settings.account). Its own screen, so the deletion flow, its confirmation and its Done stay as
 * they were when Account held nothing else.
 */
export default function DeleteAccountScreen(): ReactElement {
  return <DeleteAccount />;
}
