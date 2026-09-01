# Cursor Brief — Infra UI Brand Overhaul

Use the supplied Infra brand assets and tokens to progressively update the product UI without changing business logic or functionality.

## Brand naming

1. The primary display name is **Infra**.
2. Do not rename the product throughout the UI to “Infra Stack”.
3. `stack` is secondary and should appear only where the domain/company identity genuinely requires it, and should be visually smaller than `Infra`.
4. Domain: `infrastack.app`.
5. No tagline.

## Assets

Recommended locations:

- `src/assets/brand/infra-logo.svg`
- `src/assets/brand/infra-icon.svg`
- `src/styles/infra-brand-tokens.css`

If the repository structure differs, place them in the closest existing brand/assets/theme directories rather than creating unnecessary parallel structure.

## Design direction

The product should feel like premium enterprise AI infrastructure:

- dark-first
- minimal
- precise
- confident
- modern
- high contrast
- restrained use of effects

Avoid crypto/gaming aesthetics, neon overload, excessive glassmorphism, oversized gradients and overly rounded consumer-SaaS components.

## Colour application

Use the supplied tokens instead of duplicating hard-coded hex values.

- App background: `--infra-navy-950`
- Navigation / secondary shells: `--infra-navy-900`
- Cards / panels: `--infra-surface`
- Raised/selected surfaces: `--infra-surface-raised`
- Borders: `--infra-border`
- Primary CTA / active states: `--infra-blue`
- Secondary accent / highlights: `--infra-cyan`
- Hero/important accent only: `--infra-accent-gradient`

Blue and cyan should guide attention; they should not flood every component.

## Components

### Navigation
- Use the Infra logo/wordmark.
- Keep navigation dark, simple and uncluttered.
- Active navigation can use blue/cyan treatment, preferably subtle background + high-contrast label.

### Buttons
- Primary: blue or blue→cyan gradient when the action is genuinely primary.
- Secondary: dark surface with border.
- Destructive actions must remain semantically red rather than being forced into brand blue.

### Cards and panels
- Dark surfaces with a restrained border.
- 8–12px radius for most components.
- Avoid heavy shadow stacks.

### Inputs
- Dark surface, cool-grey border and clear blue focus state.
- Keep focus accessibility obvious.

### Typography
- Reuse the current UI font if suitable.
- If there is no coherent font system, prefer Geist or Inter.
- Do not add a new font dependency without first checking what is already installed.

## Implementation sequence

1. Inventory current hard-coded brand names, logos and colours.
2. Add the brand assets and design tokens centrally.
3. Update global shell/navigation/header first.
4. Update buttons, cards, forms, tables and status treatments.
5. Replace duplicated hard-coded colours with tokens.
6. Update login/auth/public pages.
7. Review responsive states and low-resolution logo usage.
8. Run existing tests/lint/build and fix only regressions caused by the branding work.

Do **not** rewrite unrelated logic, data flows, integrations or backend code as part of this visual overhaul.
