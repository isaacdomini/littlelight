# Tinyglow design system

Adopted 2026-10-09 (user decision). Every screen follows this. Before a step is committed, its
screens are checked visually in light and dark mode at phone (375 px) and desktop sizes.

## Principles
- Photos are the hero. UI chrome recedes: no heavy borders, no gradients, no shadows except to lift sheets/modals.
- Calm and warm, not cute. One accent colour, lots of white space, soft corners.
- One primary action per screen. Secondary actions live in sheets or overflow.
- Motion is quiet: 150–250 ms ease-out, no bounce; respect prefers-reduced-motion.
- Phone first (375 px), then tablet 2-pane, desktop 3-pane.
- Buttons and screen elements must look finished and obvious to a regular (non-technical) user:
  clear labels, consistent sizes, aligned, never default/unstyled browser controls.

## Colour (CSS tokens on :root, dark-mode variants)
- --bg #FFFFFF / dark #0E0F11
- --surface #F7F6F4 / dark #17181B
- --text #1C1C1E / dark #F2F2F3; --text-muted #6B6B70 / dark #9A9AA0
- --accent #E8836B (warm coral) / dark #F0957F; used for primary buttons, links and the selected tab only
- --border #ECEAE7 / dark #26272B (hairline, 1 px)
- Semantic: --success #3C9D6E, --warning #D9A23A, --danger #D2554A
- All text meets WCAG 2.2 AA contrast.

## Typography
- System font stack (SF Pro / Roboto / Inter fallback).
- Scale: 28/22/17/15/13 px; weights 600 for titles, 400 for body; line-height 1.4.
- Dynamic type supported; never below 13 px.

## Spacing & shape
- 4-pt grid: 4, 8, 12, 16, 24, 32.
- Screen gutter 16 px; card padding 16 px; radius 12 px (cards, sheets), 8 px (thumbs), full (chips).
- Touch targets ≥ 44 px.

## Components
- Tab bar: 5 icons with labels, accent only on the active tab, no background tint.
- Photo grid: 2 px gaps, square thumbs, no captions; age-group headers sticky and small (13 px, muted).
- Viewer: full-bleed black, controls fade after 2 s, details in a bottom sheet.
- Chat: user messages right-aligned in an accent-tinted bubble; assistant text unbubbled; photo grids inline.
- Buttons: primary = filled accent; secondary = text; destructive = danger text with confirm.
- Chips: surface background, full radius, 32 px tall.
- Empty states: one line of copy + one action, a soft illustration at most.
- Loading: skeletons matching layout, never spinners on whole screens.

## Rules
- No more than 2 font weights and 1 accent per screen.
- No modal stacks; one sheet at a time.
- Every screen reviewed in light + dark, phone + desktop, before a step is committed.
