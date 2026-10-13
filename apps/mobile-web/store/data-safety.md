# Google Play Data Safety (draft answers)

Global answers:

- Does the app collect or share required user data types? **Collects: yes. Shares: no.** Our model
  provider and hosting act as service providers processing data on our behalf; Play does not count
  that as sharing.
- Is all user data encrypted in transit? **Yes** (HTTPS only; release builds block cleartext).
- Can users request deletion? **Yes**: in-app Delete account (Settings > Account), plus a web
  deletion URL (`https://tinyglow.app/support`, placeholder) for the Console field.
- Independent security review: No. Committed to Play Families policy: No (audience is adults).

| Data type (Play category) | Collected | Shared | Optional | Purpose |
| --- | --- | --- | --- | --- |
| Personal info > Email address | Yes | No | Required | App functionality, account management |
| Personal info > Name | Yes | No | Required | App functionality |
| Photos and videos > Photos | Yes | No | Required to use the app | App functionality |
| Photos and videos > Videos | Yes | No | Optional | App functionality. Short clips the user chooses to upload (step 12): the original is stored and a 1080p playback copy is made on our server. Audio is part of the clip; it is never transcribed or analysed separately. |
| App activity > Other user-generated content (notes, milestones, chat messages) | Yes | No | Optional | App functionality |
| App activity > In-app search history | Yes | No | Optional | App functionality |
| Personal info > User IDs | Yes | No | Required | App functionality, account management |
| Location > Approximate location / Precise location | Precise: **Yes** | No | Optional | App functionality. Comes only from photo metadata. The Android Photo Picker removes it, so most Android uploads carry none. The app never requests a location permission. |

Not collected: contacts, financial info, health info, web browsing, audio (as a separate type: the
soundtrack of an uploaded video is part of "Videos" above, and the app never records audio or asks for
the microphone), files and docs, calendar, device or other IDs, app info and performance (crash logs,
diagnostics), advertising data.

Videos (step 12): picked with the same system Photo Picker as photos (no `READ_MEDIA_VIDEO`). Large
clips upload on Wi-Fi by default (the user can switch one upload to cellular). Videos in albums with
AI features on are described from a poster frame and three still frames by our model provider, under
the same no-training terms as photos; the audio track is never sent anywhere but our own storage.

Google Photos import (web, Android and iPhone): the user connects a Google account and chooses photos
in Google's own picker, which opens in the system browser. The server keeps an encrypted refresh token
(Personal info > User IDs, already declared). Photos are Photos and videos > Photos, already declared.
Google strips location from downloads, so it adds no Location data. Not shared. The Android app has
**no auto-sync**, so there is no new permission.

Passkeys (step 13): an optional, faster way to sign in to an existing account; the email code stays
the primary and recovery path. The passkey's private key is created and kept by Android / Google
Password Manager on the user's device (the user's own sync, not ours); our server stores the public
key, a name the user types ("Pixel 9") and the time it was last used. **No new data type**: a public
key is part of the account credentials already covered by "Personal info > User IDs" / "Email
address", and no biometric data is collected (the OS never shares it with the app). Not shared.

Other Console declarations:

- Ads: **No ads**. Target audience: 18+. News app / government / health app: No.
- Permissions declaration: only `INTERNET`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE` and
  `FOREGROUND_SERVICE_DATA_SYNC` in our manifest; the passkey library (Credential Manager, step 13)
  merges in the install-time `USE_BIOMETRIC` and `USE_FINGERPRINT` (no runtime prompt; they let the
  system verify the user with the screen lock when a passkey is used). The foreground service type `dataSync` is used for visible photo
  and video uploads (notification "Uploading photos and videos"); describe it that way in the
  foreground-service declaration form.
  No photo/media or location permissions (system Photo Picker). Google Photos import adds none: it goes through the browser and the server, so `READ_MEDIA_IMAGES` and `READ_MEDIA_VISUAL_USER_SELECTED` stay removed from the manifest.
- Photo and video permissions policy: not applicable (no READ_MEDIA_*).
- Push token: stored against the account for notifications; if Play review asks, it is "Device or
  other IDs, App functionality, not shared". Declare it if you want to be conservative (same
  open question as the App Store label).
