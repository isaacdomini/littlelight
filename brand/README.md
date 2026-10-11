# Tinyglow brand kit

Generated from code: `pnpm --filter @tinyglow/mobile-web exec tsx scripts/brand.ts` (source: `apps/mobile-web/scripts/brand.ts`).
The mark geometry lives in `apps/mobile-web/src/components/logo/markGeometry.ts`, shared with the in-app `<LogoMark>` / `<LogoHorizontal>`.
Output is deterministic and also refreshes the web icons in `apps/mobile-web/public` (favicons, apple-touch, PWA icons, og-image, email logo).
See `brand-sheet.png` for the overview and `clear-space.png` for the spacing diagram.

## The mark
A warm light seen through a camera: a six-blade aperture glowing butter yellow to apricot to soft coral, with two baby footprints in the warm hexagonal opening.
The approved drawing is `concept/tinyglow-icon.svg` (app icon) and `concept/tinyglow-mark.svg` (transparent mark). `logo/app-icon.svg` and `logo/mark.svg` render identically. Native icons and splash are built from the two concept files.

- The mark is always full colour, with its gradient and glow. **There is no flat, single-colour or simplified cut.** Don't make one.
- For small sizes (16-48 px: favicons, tab icons) use the **app icon** (night-purple rounded square), not the transparent mark. The small-size tuning (`logo/app-icon-small.svg`, `png/app-icon/app-icon-16|32|48.png`) makes the mark slightly larger with bolder gaps and soles. It is the same artwork, not a flat cut.
- On light backgrounds the glow is softer (the transparent `mark.svg` uses 50 % glow; in the app `--logo-glow` is 0.45 light / 0.7 dark).

## Colour
Logo colours (only for the mark and icon):

| Name | Hex | RGB | Use |
| --- | --- | --- | --- |
| Night purple | #1F1A2E | 31 26 46 | App icon background, OG image, avatars |
| Butter | #FBDF97 | 251 223 151 | Top of the blade gradient, footprints |
| Apricot | #F2B47F | 242 180 127 | Middle of the blade gradient, glow |
| Soft coral | #E8907A | 232 144 122 | Bottom of the blade gradient |

UI colours (docs/DESIGN.md). The app accent stays **coral**:

| Name | Hex | RGB | Use |
| --- | --- | --- | --- |
| Coral | #E8836B | 232 131 107 | UI accent on light |
| Coral (dark mode) | #F0957F | 240 149 127 | UI accent on dark |
| Ink | #1C1C1E | 28 28 30 | Wordmark on light |
| Paper | #F2F2F3 | 242 242 243 | Wordmark on dark |
| Night | #0E0F11 | 14 15 17 | Dark UI background |

## Typeface
Wordmark: **Nunito Bold**, SIL Open Font License 1.1 (`fonts/OFL.txt`), (c) The Nunito Project Authors.
`fonts/Nunito-Bold-subset.ttf` is the wght=700 instance of the Google Fonts variable Nunito, subset to Latin basics (made once with fontTools).
The logo files contain outlined paths only, so no font is needed to use them. In product UI use the system font stack from docs/DESIGN.md. Never use SF Pro or other system fonts in the logo.

## Clear space and minimum size
- Clear space x = the aperture radius (half the mark's circle). Keep x free on all four sides, measured from the aperture and the wordmark (not the glow).
- Minimum sizes:
  - Transparent mark: 24 px.
  - App icon (small-size tuning): 16 px.
  - Horizontal logo: 24 px mark height (about 110 px wide).
  - Stacked logo: 64 px wide.
  - Wordmark alone: 64 px wide.
- Lockup SVGs include a 40-unit margin around the mark so the glow is never clipped.

## Do and don't
- Do pick the lockup that matches the background:
  - `light` (ink wordmark) on white or pale backgrounds.
  - `dark` (paper wordmark) on near-black.
  - `white` on night purple or photos.
  - `black` on pale tinted fields.
- Do keep proportions and scale uniformly.
- Don't recolour the mark, flatten it, remove the glow, outline or rotate it, reset the wordmark in another font, or stretch anything.
- Don't add pricing or plan wording to brand assets.

## File index
- `concept/` The approved drawing: `tinyglow-icon.svg`, `tinyglow-mark.svg`, and `preview.html` (local preview, light/dark).
- `logo/` SVG masters:
  - `mark.svg` (transparent).
  - `app-icon.svg`, `app-icon-small.svg`.
  - `logo-horizontal|logo-stacked|wordmark-{light,dark,white,black}.svg` (the variant sets the wordmark colour; the mark is always full colour).
- `png/mark/` Transparent mark at 24-1024, plus `-on-white` and `-on-dark` at 512/1024.
- `png/app-icon/`:
  - `app-icon-16…1024.png` (rounded; 16-48 use the small-size tuning).
  - `app-icon-square-1024.png` (full bleed).
- `png/horizontal/`:
  - 512/1024/2048 px wide, transparent (light and dark).
  - `-on-white` and `-on-dark` versions.
- `png/stacked/`, `png/wordmark/` 1024.
- `web/`:
  - `favicon.ico` (16/32/48) and `favicon.svg` (small-size app icon).
  - `apple-touch-icon.png` (180, opaque).
  - `icon-192.png`, `icon-512.png` (rounded).
  - `icon-maskable-512.png` (full bleed, aperture inside the 80 % safe zone).
- `social/`:
  - `og-image.png` (1200x630, night field).
  - `app-icon-showcase.png`.
  - `avatar-night-400.png` (icon, full bleed).
  - `avatar-white-400.png` (mark on white).
- `email/`:
  - `logo-email.png` (480x108 = 240x54 at 2x, transparent; served as `public/email/logo.png`).
  - `logo-email-on-white.png`, `logo-email-dark.png`.
- `brand-sheet.png`, `clear-space.png`, `fonts/`.

Native app icons and splash live in `apps/mobile-web/resources/` and are built from `concept/tinyglow-icon.svg` / `concept/tinyglow-mark.svg`.
