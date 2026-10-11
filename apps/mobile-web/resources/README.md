# Brand resources

Sources for every native icon and splash, taken from the approved logo (brand/concept/tinyglow-icon.svg):
a six-blade aperture in a yellow-peach-coral gradient with a soft glow, a warm brown hexagon centre and two
outlined baby footprints, on a night-purple tile. The app UI accent stays coral (#E8836B); only icons and splash change.

- icon.svg, icon-dark.svg, icon-tinted.svg: iOS 1024 icons, full-bleed square (iOS applies the mask). The tinted one is
  converted to grayscale by the script, keeping glow and shading.
- icon-foreground.svg: Android adaptive foreground, glowing mark scaled to 0.8 so it sits inside the 66/108 safe zone.
  The adaptive background is night purple (#231B2E, values/ic_launcher_background.xml).
- icon-monochrome.svg: Android 13+ themed icon. The system forces one colour, so this is a single-colour aperture + feet cut.
- notification.svg: Android status-bar icon (white on transparent is forced by the platform): aperture + solid feet.
- splash-mark*.svg: the full-colour glowing mark, centred on white (light) or night purple #1D1829 (dark).

Regenerate: `pnpm --filter @tinyglow/mobile-web native:assets` (output is deterministic).
