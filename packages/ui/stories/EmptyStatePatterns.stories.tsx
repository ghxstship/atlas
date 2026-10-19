import type { ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, EmptyState, Input, MoreFields, PageHeader } from "../src/index.ts";

/**
 * Gate 27 patterns (finding A47-002) on production components: an empty view under a page header
 * that already holds the primary action keeps one primary by making the empty state's action
 * secondary, and a long form shows seven fields with the rest under More fields.
 */
const meta: Meta = { title: "Patterns/One Primary Action", parameters: { layout: "padded" } };
export default meta;

function UnderHeader(): ReactElement {
  return (
    <div className="flex flex-col gap-16 max-w-(--layout-wide)">
      <PageHeader
        title="Dock Schedule"
        count={0}
        actions={
          <Button variant="primary" shortcut="C">
            Book Dock Slot
          </Button>
        }
      />
      <EmptyState
        icon="CalendarClock"
        sentence="No dock slots this week. Book one for an inbound shipment."
        actionLabel="Book Dock Slot"
        actionVariant="secondary"
      />
    </div>
  );
}

const FIELDS = ["Given Name", "Family Name", "Pronouns", "Headline", "City", "Country", "Phone"];
const MORE = ["Website", "Languages", "Bio"];

function LongProfileForm(): ReactElement {
  return (
    <form aria-label="Profile" className="flex flex-col gap-12 max-w-(--ui-field)">
      {FIELDS.map((label) => (
        <Input key={label} label={label} />
      ))}
      <MoreFields>
        {MORE.map((label) => (
          <Input key={label} label={label} />
        ))}
      </MoreFields>
      <div>
        <Button variant="primary" type="submit">
          Save
        </Button>
      </div>
    </form>
  );
}

export const EmptyUnderHeader: StoryObj = {
  name: "Empty View Under a Header",
  render: () => <UnderHeader />,
};
export const LongForm: StoryObj = {
  name: "Long Form With More Fields",
  render: () => <LongProfileForm />,
};
