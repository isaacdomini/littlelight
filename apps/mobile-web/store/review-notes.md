# App Review / Play "App access" notes (draft)

Status: draft. The text lives in `fastlane/metadata/review_information/notes.txt` (App Store Connect
"Notes") and is pasted into Play Console "App access". Placeholders to replace in part B (never
commit the real values; paste them in the consoles):

| Placeholder | Replace with |
| --- | --- |
| `REVIEW_ACCOUNT_EMAIL` | the review account's email (plan U12) |
| `REVIEW_ACCOUNT_CODE` | the static 6-digit review code (api `REVIEW_ACCOUNT_CODE_HASH` holds only its hash) |
| `REVIEW_CONTACT_*` | name, email and phone of the person Apple/Google may contact |

Also set the same email/code in `metadata/review_information/demo_user.txt` and
`demo_password.txt` (App Store Connect "Sign-in required" fields), and tick "Sign-in required".

Facts the notes rely on (re-check before submitting):

- Review account has AI features enabled so Search and Chat can be demonstrated; it holds 24 illustrated
  photos from `demo:media --review-baby` (no real children).
- Native builds hide purchase prompts, so the notes say there is no purchase in the app.
- Sign in with Apple / Google are not in this build (email code only). If a later build adds Google
  sign-in on iOS, Sign in with Apple must ship with it (App Store guideline 4.8).
- Account deletion is in Settings and works for the review account.
