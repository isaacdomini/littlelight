# Release checklist (from docs/plans/step-9.md section 5.2)

Needs from the user, in order. Tick as done.

- [ ] U1 Apple Developer Program membership and Team ID
- [ ] U2 Xcode signed in with that Apple ID (App ID `app.tinyglow`: Associated Domains, Push Notifications)
- [ ] U3 App Store Connect app record, API key (Issuer ID, Key ID, .p8), TestFlight testers
- [ ] U4 APNs key (.p8, Key ID) and worker env (`PUSH_PROVIDER=live`, `APNS_*`)
- [ ] U5 Google Play Console account, app `app.tinyglow`, Play App Signing, upload keystore (kept outside the repo)
- [ ] U6 SHA-256 fingerprints (Play signing + upload) into `assetlinks.json`; Team ID into the AASA file
- [ ] U7 Firebase project, `google-services.json` in `android/app/` (git-ignored), FCM service account, build with `VITE_PUSH_ANDROID=1`
- [ ] U8 Apple / Google sign-in client IDs (before public launch; not in this build)
- [ ] U9 Payments decision (billing is a later step; native hides purchase prompts and the listings do not mention purchase)
- [ ] U10 Production deploy approval so `/.well-known/*` serves the real files
- [ ] U11 Listing review: name/trademark check, subtitle and description, support URL and email, real Privacy Policy and Terms text, age-rating answers, privacy label, Data Safety, screenshots
- [ ] U12 Review account: email, static code (hash into api env), run `db:review-family` and `demo:media --review-baby` on production; paste credentials into the review notes
- [ ] U13 Machine actions done (`xcodebuild -license`, runtimes)

Before each submission:

- [ ] `pnpm --filter @tinyglow/mobile-web native:build:release` with `VITE_API_URL=https://...` (no live reload, no mixed content)
- [ ] `DEVELOPMENT_TEAM` set; archive and upload (`fastlane ios beta` or Xcode)
- [ ] `./gradlew bundleRelease` with `android/keystore.properties`; first AAB uploaded by hand
- [ ] `store/check-limits.sh` passes; placeholders (`REVIEW_*`, URLs) replaced in the consoles
- [ ] Store label and Data Safety re-read against `PrivacyInfo.xcprivacy` and `AndroidManifest.xml`
- [ ] Push opt-in, deep links (invite and share link from Mail) and account deletion verified on a real device
