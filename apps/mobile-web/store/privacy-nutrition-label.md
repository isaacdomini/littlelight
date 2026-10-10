# App Store privacy label (draft answers for App Store Connect > App Privacy)

Must match `ios/App/App/PrivacyInfo.xcprivacy` exactly. Tracking: **No**. Tracking domains: none.
Every item below: **Linked to the user = Yes**, **Used for tracking = No**, purpose **App
Functionality** only (no analytics, no advertising, no personalisation, no developer marketing).

| Apple data type | Collected | What it is here |
| --- | --- | --- |
| Contact Info > Email Address | Yes | Sign-in and invites |
| Contact Info > Name | Yes | Display name shown to family |
| User Content > Photos or Videos | Yes | The baby photos the user uploads |
| User Content > Other User Content | Yes | Notes, milestones, measurements, chat messages, baby name and birth date |
| Search History > Search History | Yes | Search and chat queries, to return results |
| Identifiers > User ID | Yes | Account id |
| Location > Precise Location | Yes | GPS embedded in photo metadata (iPhone keeps it). The app never asks for device location. Stored encrypted; shown to the parent only as a coarse place name. |

Not collected: Coarse Location, Contacts, Health and Fitness, Financial Info, Browsing History,
Purchases, Usage Data, Diagnostics, Sensitive Info, Device ID, Advertising Data. No face data.

Third-party processing: our AI model provider processes photos and queries for albums with AI features enabled only,
as our processor under a data-processing agreement, with training on the data excluded. It is not a
third-party use for tracking or ads. Server-side error reporting (Sentry) is not part of the app.

## Open questions for the user (confirm before submitting)

1. **Push token / Device ID.** Notification opt-in stores an APNs token linked to the account.
   `PrivacyInfo.xcprivacy` does not list Device ID, following the plan. Apple's guidance is not
   explicit for push tokens; declare "Identifiers > Device ID, App Functionality, linked" if you
   prefer to be conservative, and add it to the manifest in the same change.
2. If a client crash/analytics SDK is ever added, this label changes.
3. Payments: when billing ships, add Purchases (and the manifest) in that change.
