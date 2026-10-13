import Foundation

// Public keys that may sign a live-update manifest (docs/plans/step-14.md D6). ECDSA P-256,
// SubjectPublicKeyInfo DER in standard base64. Must equal APP_UPDATE_PUBLIC_KEYS in
// packages/shared/src/app-update.ts and android/.../update/UpdateKeys.java (CI:
// .github/scripts/app-update-hygiene.sh). Rotation: add a key with a new keyId here, ship a store
// build, then switch the server.
//
// The dev key (private half committed in .env.dev) exists only in Debug builds: a Release binary
// neither contains nor trusts it.
enum LLUpdateKeys {
    static let prodKeyId = "prod-2026-10"
    static let prodSpkiBase64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAaou0YPN124j6e+8Ig6+WC/K2HcOGom7OWaM4Gqpqd+KBMjoRimHim4zFf+cDW/YNegBgOgH3nbIRgSczj2AnQ=="

    #if DEBUG
    static let devKeyId = "dev"
    static let devSpkiBase64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmF4/OE/rfPgzXHUS+6VBcqWMWvqO4h+6HFhn1hGFzFJq2D8+w6JduoO6BU5aSmqyW74hxsVh1uqA79xVFlGFyw=="
    #endif

    /// keyId -> SPKI base64.
    static var trusted: [String: String] {
        var keys = [prodKeyId: prodSpkiBase64]
        #if DEBUG
        keys[devKeyId] = devSpkiBase64
        #endif
        return keys
    }
}
