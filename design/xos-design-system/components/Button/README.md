# Button

Button triggers one action; exactly one primary per screen, everything else secondary, ghost or in overflow.

- Variants: `primary` (accent fill, the one action the screen is for), `secondary` (default), `ghost` (toolbars, dialog cancel), `danger` (destructive, always paired with Undo or a confirmation for irreversible work).
- Sizes: `sm` 24 px, `md` 28 px (default), `lg` 32 px from `control-*` tokens.
- Labels are Title Case and at most three words, verb first: Create Record, Approve, Export.
- Pass `shortcut` to show the key in a Kbd; every action has one.
- `loading` sets `aria-busy` and blocks repeat clicks without a blocking spinner elsewhere.
- States: default, hover (`bg-hover` or brightness on primary), focus (2 px `focus-ring`), active, disabled (`opacity-disabled`), loading.
