import { Redirect } from "expo-router";

/** The launch route: Compass opens on Today, the first tab (Section 4.5.7). */
export default function Index() {
  return <Redirect href="/today" />;
}
