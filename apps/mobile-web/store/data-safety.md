# Google Play Data Safety (draft answers)

Global answers:

- Does the app collect or share required user data types? **Collects: yes. Shares: no.** Our model
  provider and hosting act as service providers processing data on our behalf; Play does not count
  that as sharing.
- Is all user data encrypted in transit? **Yes** (HTTPS only; release builds block cleartext).
- Can users request deletion? **Yes**: in-app Delete account (Settings > Account), plus a web
  deletion URL (`https://littlelight.tesarsoft.com/support`, placeholder) for the Console field.
- Independent security review: No. Committed to Play Families policy: No (audience is adults).

| Data type (Play category) | Collected | Shared | Optional | Purpose |
| --- | --- | --- | --- | --- |
| Personal info > Email address | Yes | No | Required | App functionality, account management |
| Personal info > Name | Yes | No | Required | App functionality |
| Photos and videos > Photos | Yes | No | Required to use the app | App functionality |
| App activity > Other user-generated content (notes, milestones, chat messages) | Yes | No | Optional | App functionality |
| App activity > In-app search history | Yes | No | Optional | App functionality |
| Personal info > User IDs | Yes | No | Required | App functionality, account management |
| Location > Approximate location / Precise location | Precise: **Yes** | No | Optional | App functionality. Comes only from photo metadata. The Android Photo Picker removes it, so most Android uploads carry none. The app never requests a location permission. |

Not collected: contacts, financial info, health info, web browsing, audio, files and docs, calendar,
device or other IDs, app info and performance (crash logs, diagnostics), advertising data.

Other Console declarations:

- Ads: **No ads**. Target audience: 18+. News app / government / health app: No.
- Permissions declaration: only `INTERNET`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE` and
  `FOREGROUND_SERVICE_DATA_SYNC`. The foreground service type `dataSync` is used for visible photo
  uploads ("Uploading N photos"); describe it that way in the foreground-service declaration form.
  No photo/media or location permissions (system Photo Picker).
- Photo and video permissions policy: not applicable (no READ_MEDIA_*).
- Push token: stored against the account for notifications; if Play review asks, it is "Device or
  other IDs, App functionality, not shared". Declare it if you want to be conservative (same
  open question as the App Store label).
