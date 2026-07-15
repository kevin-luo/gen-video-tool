# UI token decision record

## Craft settings

- CRAFT_LEVEL: 9
- UI_MOTION: 4
- VISUAL_DENSITY: 8
- DESIGN_VARIANCE: 5
- Theme: light Graphite workspace with a dark neutral preview stage
- Accent: cinnabar red, reserved for the primary action, focus, selection, and blocking errors
- Signature bet: a torn-paper registration tab marks the active shot consistently in the shot rail and timeline

## Token spine

The implementation must expose primitive, semantic, and component tokens in CSS. No feature component may introduce an untracked color, spacing, radius, duration, shadow, or z-index.

### Primitive direction

- Neutral hue: subtly cool graphite, never pure black or white.
- Accent hue: OKLCH hue near 28–32, with lower chroma in dark surfaces.
- Spacing: 4/8/12/16/24/32/48 px; dense editor controls may use 6 px only through a named compact token.
- Radii: 3 px for compact controls, 6 px for panels, 10 px for dialogs; the video canvas remains nearly square.
- Type: system CJK sans for body, tabular numerals, a compact mono only for timecode and file paths.
- Motion: 80/150/240/400 ms; no elastic or decorative idle motion in the desktop UI.
- Z-index: base, raised, dropdown, sticky, backdrop, modal, toast, tooltip.

### Semantic surface stack

- `surface-canvas`: app background
- `surface-panel`: shot/property/timeline panes
- `surface-raised`: controls and popovers
- `surface-stage`: dark preview stage
- `surface-sunken`: code/path/validation details
- `text-primary`, `text-secondary`, `text-tertiary`
- `border-subtle`, `border-default`, `border-strong`, `border-focus`
- `status-success`, `status-warning`, `status-error`, `status-info`

### Interaction contract

- Minimum pointer target: 44 px unless a dense desktop control expands its hit area invisibly.
- All icon-only buttons need an accessible name and tooltip.
- Focus is always visible; dialogs trap focus and restore it.
- Hover transforms are pointer-gated; reduced motion disables spatial transitions.
- Disabled actions always expose the blocking reason inline or on invocation.
