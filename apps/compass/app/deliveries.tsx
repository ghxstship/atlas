import type { ReactElement } from "react";
import { ExternalPageScreen } from "../src/screens/ExternalPageScreen";

/** The deliveries More screen for external role types (Section 4.5.7, A92); see src/domain/external.ts. */
export default function DeliveriesScreen(): ReactElement {
  return <ExternalPageScreen page="deliveries" />;
}
