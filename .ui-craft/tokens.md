# UI token decision record

## Craft settings

- CRAFT_LEVEL: 9
- UI_MOTION: 3
- VISUAL_DENSITY: 3
- DESIGN_VARIANCE: 4
- Theme: warm porcelain creator canvas with neutral graphite type
- Accent: cinnabar red, reserved for the primary action, active navigation, focus, and errors
- Signature bet: the large script canvas transforms in place into generation progress and the finished-video preview

## Token spine

The implementation keeps primitive, semantic, and component tokens in CSS. Feature components must not introduce untracked colors, spacing, radii, durations, shadows, or z-index values.

### Primitive direction

- Neutral hue: warm paper-white surfaces with graphite text, never pure black or pure white across large areas.
- Accent hue: OKLCH hue near 28–32; one accent per viewport.
- Spacing: 4/8/12/16/24/32/48/64/96 px; the creator canvas uses fluid spacing through named tokens.
- Radii: 6 px inputs, 10 px controls and media cards, 14 px large composer/result surfaces.
- Type: system CJK sans for body and controls; 16 px body floor; tabular numerals for time and progress.
- Motion: 80/150/240/400 ms; no bounce or decorative idle motion; reduced-motion users get instant spatial changes.
- Z-index: base, raised, dropdown, sticky, backdrop, modal, toast, tooltip.

### Semantic surface stack

- `surface-canvas`: warm app background
- `surface-panel`: white creation and result surfaces
- `surface-raised`: controls, menus, and recent-work cards
- `surface-stage`: dark video preview
- `surface-sunken`: advanced diagnostics and paths
- `text-primary`, `text-secondary`, `text-tertiary`
- `border-subtle`, `border-default`, `border-strong`, `border-focus`
- `status-success`, `status-warning`, `status-error`, `status-info`

### Creator component metrics

- Header height: 72 px desktop, 60 px compact.
- Creator max width: 1120 px.
- Composer minimum height: 248 px desktop, 208 px compact.
- Primary action height: 64 px desktop, 56 px compact.
- Recent-work media ratio: 16:9.
- Minimum interactive target: 44 px.

### Interaction contract

- The textarea has a persistent programmatic label plus visible placeholder/helper text; paste is never blocked.
- `Ctrl/Cmd + Enter` starts generation; plain Enter creates a new line.
- Submit stays enabled until a request begins, then retains its label and shows progress.
- Errors are inline, focusable, specific, and recoverable without losing the script.
- Platform selection is a visible segmented control, not a hidden dropdown.
- Advanced controls use disclosure and preserve the simple default route.
- Focus is always visible; dialogs trap focus and restore it.
- Hover transforms are pointer-gated; reduced motion disables spatial transitions.
