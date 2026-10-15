import type { ReactElement, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Checkbox, Input, StateChip, Switch } from "../src/index.ts";

/**
 * The two design previews that are not a single component (RRR-75): the system cover and the
 * control state matrix, rebuilt on production components and token utilities.
 */
const meta: Meta = { title: "Foundations/Showcase", parameters: { layout: "fullscreen" } };
export default meta;

const DOTS = [860, 884, 908, 932].flatMap((cx) =>
  [172, 196, 220, 244, 268].map((cy) => ({ cx, cy })),
);

function CoverArt(): ReactElement {
  return (
    <div className="relative w-full max-w-(--layout-wide) h-(--ui-shell-min) overflow-hidden bg-bg-canvas">
      <svg
        width="960"
        height="288"
        viewBox="0 0 960 288"
        aria-hidden="true"
        className="absolute start-0 top-0"
      >
        <rect className="fill-accent" x="512" y="-8" width="192" height="216" rx="8" />
        <rect className="fill-viz-seq-3" x="512" y="224" width="192" height="72" rx="8" />
        <rect className="fill-state-in-review" x="720" y="-8" width="112" height="136" rx="8" />
        <rect className="fill-state-scheduled" x="720" y="144" width="112" height="152" rx="8" />
        <rect className="fill-text-primary" x="848" y="48" width="120" height="96" rx="8" />
        {DOTS.map((d) => (
          <circle key={`${d.cx}-${d.cy}`} className="fill-accent" cx={d.cx} cy={d.cy} r="2" />
        ))}
      </svg>
      <div className="absolute start-40 bottom-40 max-w-(--ui-field)">
        <h1 className="m-0 text-heading-32 font-semibold text-text-primary">
          XOS Design
          <br />
          System
        </h1>
        <p className="mt-16 mb-0 text-text-13 text-text-secondary">
          Calm, dense and keyboard-first, for Atlas, Gateway and Compass.
        </p>
      </div>
    </div>
  );
}

export const Cover: StoryObj = { render: () => <CoverArt /> };

const STATES = ["Default", "Disabled", "Loading", "Error"] as const;

function Row({ label, cells }: { label: string; cells: ReactNode[] }): ReactElement {
  return (
    <>
      <span className="text-label-13 font-medium text-text-secondary">{label}</span>
      {cells.map((cell, i) => (
        <div key={STATES[i]}>{cell}</div>
      ))}
    </>
  );
}

function NotApplicable(): ReactElement {
  return <span className="text-text-secondary">Not applicable</span>;
}

function ControlMatrix(): ReactElement {
  return (
    <div className="grid grid-cols-5 items-center gap-16 p-24">
      <span />
      {STATES.map((s) => (
        <span key={s} className="text-text-12 font-medium text-text-secondary">
          {s}
        </span>
      ))}
      <Row
        label="Primary"
        cells={[
          <Button key="d" variant="primary">
            Approve
          </Button>,
          <Button key="x" variant="primary" disabled>
            Approve
          </Button>,
          <Button key="l" variant="primary" loading>
            Approve
          </Button>,
          <NotApplicable key="e" />,
        ]}
      />
      <Row
        label="Secondary"
        cells={[
          <Button key="d">Export</Button>,
          <Button key="x" disabled>
            Export
          </Button>,
          <Button key="l" loading>
            Export
          </Button>,
          <NotApplicable key="e" />,
        ]}
      />
      <Row
        label="Danger"
        cells={[
          <Button key="d" variant="danger">
            Archive
          </Button>,
          <Button key="x" variant="danger" disabled>
            Archive
          </Button>,
          <Button key="l" variant="danger" loading>
            Archive
          </Button>,
          <NotApplicable key="e" />,
        ]}
      />
      <Row
        label="Input"
        cells={[
          <Input key="d" label="Project Key" defaultValue="NWL" width="100%" />,
          <Input key="x" label="Project Key" defaultValue="NWL" width="100%" disabled />,
          <NotApplicable key="l" />,
          <Input
            key="e"
            label="Project Key"
            defaultValue="NW"
            width="100%"
            error="2 to 5 letters"
          />,
        ]}
      />
      <Row
        label="Checkbox"
        cells={[
          <Checkbox key="d" label="Blocking" defaultChecked />,
          <Checkbox key="x" label="Blocking" defaultChecked disabled />,
          <NotApplicable key="l" />,
          <NotApplicable key="e" />,
        ]}
      />
      <Row
        label="Switch"
        cells={[
          <Switch key="d" label="Sync" defaultChecked />,
          <Switch key="x" label="Sync" disabled />,
          <NotApplicable key="l" />,
          <NotApplicable key="e" />,
        ]}
      />
      <Row
        label="Chip"
        cells={[
          <StateChip key="d" state="active" label="Active" />,
          <StateChip key="x" state="canceled" label="Canceled" />,
          <NotApplicable key="l" />,
          <StateChip key="e" state="blocked" label="Blocked" />,
        ]}
      />
    </div>
  );
}

export const ControlStates: StoryObj = { name: "Control States", render: () => <ControlMatrix /> };
