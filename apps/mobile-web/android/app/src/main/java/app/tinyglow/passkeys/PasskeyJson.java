package app.tinyglow.passkeys;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Pure org.json half of the TinyglowPasskeys plugin (docs/plans/step-13.md 2.6), JVM-testable
 * (PasskeyJsonTest): prepares the request JSON for Credential Manager and reduces its response JSON
 * to exactly the API's PublicKeyCredential shape (packages/shared/src/api/auth.ts
 * publicKeyCredentialJsonSchema; base64url unpadded, clientExtensionResults may be {}).
 *
 * Decision h: GoTrue's registration options.user.id is the base64url of the 36-char UUID string. It
 * is validated as base64url and copied through untouched; the assertion's userHandle is returned
 * verbatim. Decision g: both requests are forced to userVerification "required".
 *
 * Nothing here logs.
 */
public final class PasskeyJson {
    /** Build-time relying party id: must equal GOTRUE_WEBAUTHN_RP_ID and the assetlinks host. */
    public static final String RP_ID = "tinyglow.app";

    /** The options are not what the API sends (plugin error "failed"). */
    public static final class BadOptions extends Exception {
        BadOptions() { super("bad options"); }
    }

    /** The options name another RP than the build's (plugin error "not_configured"); e.g. the dev stack. */
    public static final class WrongRelyingParty extends Exception {
        WrongRelyingParty() { super("wrong relying party"); }
    }

    private static final Set<String> TRANSPORTS = new HashSet<>(
        Arrays.asList("usb", "nfc", "ble", "internal", "hybrid", "smart-card"));

    private PasskeyJson() {}

    /** Creation options -> CreatePublicKeyCredentialRequest.requestJson (userVerification forced to required). */
    public static String creationRequest(JSONObject options, String rpId) throws BadOptions, WrongRelyingParty {
        try {
            JSONObject copy = new JSONObject(options.toString());
            JSONObject rp = copy.optJSONObject("rp");
            if (rp == null || !rp.has("id")) throw new BadOptions();
            if (!rpId.equals(rp.getString("id"))) throw new WrongRelyingParty();
            requireBase64Url(copy.optString("challenge", null));
            JSONObject user = copy.optJSONObject("user");
            if (user == null) throw new BadOptions();
            requireBase64Url(user.optString("id", null));
            if (user.optString("name", "").isEmpty()) throw new BadOptions();
            JSONObject selection = copy.optJSONObject("authenticatorSelection");
            if (selection == null) {
                selection = new JSONObject();
                copy.put("authenticatorSelection", selection);
            }
            selection.put("userVerification", "required");
            return copy.toString();
        } catch (JSONException e) {
            throw new BadOptions();
        }
    }

    /** Request options -> GetPublicKeyCredentialOption.requestJson (userVerification forced to required). */
    public static String assertionRequest(JSONObject options, String rpId) throws BadOptions, WrongRelyingParty {
        try {
            JSONObject copy = new JSONObject(options.toString());
            if (!copy.has("rpId")) throw new BadOptions();
            if (!rpId.equals(copy.getString("rpId"))) throw new WrongRelyingParty();
            requireBase64Url(copy.optString("challenge", null));
            copy.put("userVerification", "required");
            return copy.toString();
        } catch (JSONException e) {
            throw new BadOptions();
        }
    }

    /**
     * Credential Manager's registrationResponseJson / authenticationResponseJson -> the API's
     * PublicKeyCredential JSON: only the schema's keys, every binary field validated as base64url
     * (padding stripped), userHandle verbatim, clientExtensionResults an object or {}.
     */
    public static JSONObject credential(JSONObject response, boolean registration) throws BadOptions {
        try {
            JSONObject out = new JSONObject();
            String id = base64Url(response.optString("id", null));
            String rawId = response.has("rawId") ? base64Url(response.optString("rawId", null)) : id;
            if (!"public-key".equals(response.optString("type", "public-key"))) throw new BadOptions();
            out.put("id", id);
            out.put("rawId", rawId);
            out.put("type", "public-key");

            JSONObject in = response.optJSONObject("response");
            if (in == null) throw new BadOptions();
            JSONObject res = new JSONObject();
            res.put("clientDataJSON", base64Url(in.optString("clientDataJSON", null)));
            if (registration) {
                res.put("attestationObject", base64Url(in.optString("attestationObject", null)));
                JSONArray transports = in.optJSONArray("transports");
                if (transports != null) {
                    JSONArray kept = new JSONArray();
                    for (int i = 0; i < transports.length(); i++) {
                        String t = transports.optString(i, "");
                        if (TRANSPORTS.contains(t)) kept.put(t);
                    }
                    if (kept.length() > 0) res.put("transports", kept);
                }
            } else {
                res.put("authenticatorData", base64Url(in.optString("authenticatorData", null)));
                res.put("signature", base64Url(in.optString("signature", null)));
                if (in.isNull("userHandle") || !in.has("userHandle")) {
                    res.put("userHandle", JSONObject.NULL);
                } else {
                    // Verbatim: this is what GoTrue handed out as user.id (decision h).
                    String handle = in.optString("userHandle", "");
                    if (!handle.isEmpty()) requireBase64Url(handle);
                    res.put("userHandle", handle.isEmpty() ? JSONObject.NULL : handle);
                }
            }
            out.put("response", res);

            String attachment = response.optString("authenticatorAttachment", null);
            if ("platform".equals(attachment) || "cross-platform".equals(attachment)) {
                out.put("authenticatorAttachment", attachment);
            }
            JSONObject ext = response.optJSONObject("clientExtensionResults");
            out.put("clientExtensionResults", ext == null ? new JSONObject() : new JSONObject(ext.toString()));
            return out;
        } catch (JSONException e) {
            throw new BadOptions();
        }
    }

    /** True for a non-empty string of the base64url alphabet (padding tolerated). */
    public static boolean isBase64Url(String s) {
        if (s == null || s.isEmpty()) return false;
        int pad = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '=') { pad++; continue; }
            if (pad > 0) return false; // padding only at the end
            boolean ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
            if (!ok) return false;
        }
        int body = s.length() - pad;
        return body > 0 && body % 4 != 1;
    }

    /** Validates and strips padding. */
    static String base64Url(String s) throws BadOptions {
        requireBase64Url(s);
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '=') end--;
        return s.substring(0, end);
    }

    private static void requireBase64Url(String s) throws BadOptions {
        if (!isBase64Url(s)) throw new BadOptions();
    }

    /** Test helper: the top-level keys of a JSONObject. */
    static Set<String> keys(JSONObject o) {
        Set<String> out = new HashSet<>();
        for (Iterator<String> it = o.keys(); it.hasNext();) out.add(it.next());
        return out;
    }
}
