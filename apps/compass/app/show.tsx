import type { ReactElement } from "react";
import { Gate } from "../src/screens/common";
import { ShowView } from "../src/screens/ShowView";

export default function ShowScreen(): ReactElement {
  return (
    <Gate feature="show.live">
      <ShowView readOnly={false} />
    </Gate>
  );
}
