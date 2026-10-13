package app.tinyglow.update;

import app.tinyglow.BuildConfig;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * Public keys that may sign a live-update manifest (docs/plans/step-14.md D6). ECDSA P-256,
 * SubjectPublicKeyInfo DER in standard base64. Must equal APP_UPDATE_PUBLIC_KEYS in
 * packages/shared/src/app-update.ts and ios/App/App/LLUpdateKeys.swift (CI:
 * .github/scripts/app-update-hygiene.sh). Rotation: add a key with a new keyId here, ship a store
 * build, then switch the server.
 *
 * The dev key (private half committed in .env.dev) is trusted by Debug builds only. Its literal sits
 * inside `if (BuildConfig.DEBUG)`: DEBUG is a compile-time constant, so javac drops the block (and the
 * string) from release classes.
 */
public final class UpdateKeys {

    private UpdateKeys() {}

    public static final String PROD_KEY_ID = "prod-2026-10";
    public static final String PROD_SPKI_BASE64 =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAaou0YPN124j6e+8Ig6+WC/K2HcOGom7OWaM4Gqpqd+KBMjoRimHim4zFf+cDW/YNegBgOgH3nbIRgSczj2AnQ==";

    /** keyId -> SPKI base64. */
    public static Map<String, String> trusted() {
        Map<String, String> keys = new HashMap<>();
        keys.put(PROD_KEY_ID, PROD_SPKI_BASE64);
        if (BuildConfig.DEBUG) {
            keys.put(
                "dev",
                "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmF4/OE/rfPgzXHUS+6VBcqWMWvqO4h+6HFhn1hGFzFJq2D8+w6JduoO6BU5aSmqyW74hxsVh1uqA79xVFlGFyw=="
            );
        }
        return Collections.unmodifiableMap(keys);
    }
}
