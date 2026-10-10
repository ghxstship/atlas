# Input

Input is a labeled single-line text field with help text or an inline error.

- Label above, sentence-case help below. Fields with legal or financial meaning always carry help.
- Errors name the field, the problem and the fix in one sentence, validated as the person types.
- Border is `border-control`, which meets the 3:1 non-text minimum; focus replaces it with a 2 px `focus-ring`.
- `width` sets the field width; it is 280 px by default and never wider than its container.
