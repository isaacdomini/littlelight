# Screenshots (captured in 9.17)

Capture the demo family (Maya's illustrated photos) only. Never real photos. Light mode.
iPhone only for v1, so no iPad set.

| Store | Size (px) | Device |
| --- | --- | --- |
| App Store 6.9" (required) | 1320 x 2868 | iPhone 17 Pro Max / 16 Pro Max simulator |
| App Store 6.5" (required if no 6.9 set is accepted for older devices) | 1284 x 2778 | iPhone 14 Plus simulator |
| Google Play phone | 1080 x 1920 up to 1440 x 2880 (16:9 to 9:16, 2 to 8 images) | Pixel emulator |
| Play feature graphic | 1024 x 500 | made from `resources/` mark on coral |

Screens, in order: 1. Timeline by age. 2. Full-screen viewer with details. 3. Search results
("beach in June"). 4. Chat answer with photos. 5. Share link sheet (private, expires). 6. Upload
picker.

Commands: `xcrun simctl io booted screenshot out.png`; `adb exec-out screencap -p > out.png`.
Hide the status-bar clock oddities with `xcrun simctl status_bar booted override --time 9:41`.
Do not advertise pricing or purchase in screenshot captions.
