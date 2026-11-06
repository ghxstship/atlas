import { dayTypeTone, type DayType } from "@xos/data/schedule-days";
import { Icon } from "@xos/ui";

const SWATCH: Readonly<Record<number, string>> = {
  1: "bg-viz-cat-1",
  2: "bg-viz-cat-2",
  3: "bg-viz-cat-3",
  4: "bg-viz-cat-4",
  5: "bg-viz-cat-5",
  6: "bg-viz-cat-6",
  7: "bg-viz-cat-7",
};

/**
 * A day's types as tags (B4, G-38): text, an icon and a categorical swatch, so a type never reads by colour alone.
 * The day sheet peek and the crew band show them.
 */
export function DayTypeTags({
  label,
  tags,
  more = 0,
  moreLabel,
}: {
  label: string;
  tags: readonly { readonly label: string; readonly dayType: DayType }[];
  more?: number;
  moreLabel?: string;
}) {
  if (tags.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-4 p-0" aria-label={label}>
      {tags.map((tag) => {
        const tone = dayTypeTone(tag.dayType);
        return (
          <li
            key={tag.label}
            className="inline-flex items-center gap-4 rounded-chip bg-bg-surface px-6 text-text-12"
          >
            <span
              aria-hidden="true"
              className={`inline-block size-(--space-8) rounded-mark ${SWATCH[tone.category] ?? ""}`}
            />
            <Icon name={tone.icon} size={12} />
            {tag.label}
          </li>
        );
      })}
      {more > 0 && moreLabel ? (
        <li className="text-text-12 text-text-secondary">{moreLabel}</li>
      ) : null}
    </ul>
  );
}
