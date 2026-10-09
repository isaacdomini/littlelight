# Store drafts

Everything here is a draft for the user to review and submit (part B). Nothing is submitted by code.

| File | Purpose |
| --- | --- |
| `../fastlane/metadata/**` | Listing text in fastlane layout (fastlane is not installed; files only) |
| `review-notes.md` | Placeholders and facts for App Review / Play App access |
| `privacy-nutrition-label.md` | App Store privacy answers (mirror `PrivacyInfo.xcprivacy`) |
| `data-safety.md` | Play Data Safety answers |
| `age-rating.md` | 4+ / Everyone questionnaire answers |
| `screenshots.md` | Required sizes and screens |
| `release-checklist.md` | The user's list of accounts and steps |
| `check-limits.sh` | Character-limit check (`sh store/check-limits.sh`) |

## Limits checked

| Field | Limit |
| --- | --- |
| App Store name, subtitle | 30 |
| Keywords | 100 |
| Promotional text | 170 |
| Description, release notes, review notes | 4000 |
| Play title | 30 |
| Play short description | 80 |
| Play full description | 4000 |
| Play changelog | 500 |

Rules for copy: no pricing, no mention of purchase or subscription (native hides them; billing is a
later step), no "best/#1" claims, include the AI disclosure and "no ads, no tracking".
