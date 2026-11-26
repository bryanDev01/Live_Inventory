# Design direction

This document defines the visual direction for the first inventory prototype. It is intentionally small and light-only.

## Principles

- Keep the first flow to a visual sign-in screen and a welcome view.
- Use only information confirmed in `PRODUCT.md` and `AGENTS.md`.
- Do not show invented products, rates, or prices.
- The sign-in screen is a prototype and does not authenticate users or retain credentials.
- Make the layout responsive for Android phones and Windows laptops.

## Typography

- Primary typeface: Source Sans 3.
- Local fallback stack: Segoe UI, then the platform sans-serif default. Do not make a third-party font request from this private prototype.
- Use a clear type scale: display heading from 2.25rem to 3.25rem, page heading from 2rem to 2.75rem, section heading 1.5rem, body 1rem, and caption 0.875rem.
- Display headings use letter spacing between -0.02em and -0.04em.
- Review prices and rates in context before adopting this direction for real data screens.

## Color tokens

The palette uses warm neutrals and one blue accent. The accent is chosen for visibility and contrast, not brand meaning.

| Token | Value | Use |
| --- | --- | --- |
| `--color-page` | `#F3F1EB` | Page background |
| `--color-surface` | `#FCFAF5` | Main surface |
| `--color-ink` | `#242B2A` | Primary text |
| `--color-muted` | `#485553` | Secondary text |
| `--color-accent` | `#174F7A` | Primary actions and focus |
| `--color-accent-hover` | `#123E60` | Primary action hover |
| `--color-on-accent` | `#F9F7F1` | Text on the primary action |
| `--color-border` | `#65716E` | Input and surface borders |

Contrast ratios were calculated with the WCAG relative-luminance formula. Ink on surface is 13.85:1, muted text on surface is 7.46:1, on-accent text on accent is 8.05:1, and the border on surface is 4.86:1. The accent on the page background is 7.63:1. These pairs exceed the selected WCAG 2.2 AA text contrast thresholds.

## Layout and surfaces

- Use an asymmetric two-column sign-in composition on wide screens, collapsing to one column on small screens.
- Use a restrained surface border, not a border and diffuse shadow together.
- Vary corner treatment by element: 14px for a main panel, 6px for fields, and 5px for buttons.
- Keep one page-level surface at a time. Do not nest cards.
- Avoid decorative gradients, glass effects, and unnecessary motion.

## Accessibility and states

- Target WCAG 2.2 AA contrast for text.
- Keep focus visible with a high-contrast outline.
- Preserve clear labels for the name and password fields.
- Do not communicate meaning through color alone. Any future rate direction must also use a sign or symbol and text.
- Buttons have hover, focus-visible, and disabled treatments. The prototype has no loading state because its view change is immediate.
- The inventory view starts with an honest empty state.

## Prototype boundary

Submitting the sign-in form only changes the visible view. It does not validate, transmit, or save the entered values. The welcome view contains no product or exchange-rate data until real data is provided by a future authorized implementation.
