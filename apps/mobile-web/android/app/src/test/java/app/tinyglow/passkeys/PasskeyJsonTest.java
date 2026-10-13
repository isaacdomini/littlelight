package app.tinyglow.passkeys;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * JVM unit test of the passkey JSON mapping (docs/plans/step-13.md 13.6): user verification forced to
 * "required" on both requests (decision g), GoTrue's user.id copied through untouched and the
 * assertion's userHandle returned verbatim (decision h), the relying-party check, base64url
 * validation/unpadding, and that the credential JSON carries exactly the API schema's keys.
 * Run: JAVA_HOME=<jdk 21> ./gradlew testDebugUnitTest --tests 'app.tinyglow.passkeys.*'
 */
public class PasskeyJsonTest {
    private static final String UUID = "550e8400-e29b-41d4-a716-446655440000";
    private static final String USER_ID = b64url(UUID.getBytes(StandardCharsets.UTF_8));
    private static final String CHALLENGE = b64url(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 });

    private static String b64url(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static JSONObject creationOptions(String rpId) throws Exception {
        return new JSONObject()
            .put("rp", new JSONObject().put("id", rpId).put("name", "Tinyglow"))
            .put("user", new JSONObject().put("id", USER_ID).put("name", "parent@example.com").put("displayName", "parent@example.com"))
            .put("challenge", CHALLENGE)
            .put("pubKeyCredParams", new JSONArray().put(new JSONObject().put("type", "public-key").put("alg", -7)))
            .put("authenticatorSelection", new JSONObject().put("residentKey", "required").put("userVerification", "preferred"))
            .put("attestation", "none")
            .put("excludeCredentials", new JSONArray().put(new JSONObject().put("type", "public-key").put("id", "AQID")));
    }

    private static JSONObject requestOptions(String rpId) throws Exception {
        return new JSONObject()
            .put("rpId", rpId)
            .put("challenge", CHALLENGE)
            .put("userVerification", "preferred")
            .put("allowCredentials", new JSONArray());
    }

    @Test
    public void creationRequestForcesUserVerificationAndPassesUserIdThrough() throws Exception {
        JSONObject in = creationOptions(PasskeyJson.RP_ID);
        JSONObject out = new JSONObject(PasskeyJson.creationRequest(in, PasskeyJson.RP_ID));
        assertEquals("required", out.getJSONObject("authenticatorSelection").getString("userVerification"));
        assertEquals("required", out.getJSONObject("authenticatorSelection").getString("residentKey"));
        assertEquals(USER_ID, out.getJSONObject("user").getString("id"));
        assertEquals(36, Base64.getUrlDecoder().decode(out.getJSONObject("user").getString("id")).length);
        assertEquals(CHALLENGE, out.getString("challenge"));
        assertEquals("tinyglow.app", out.getJSONObject("rp").getString("id"));
        assertEquals(1, out.getJSONArray("excludeCredentials").length());
        // The input is not mutated (a copy is sent).
        assertEquals("preferred", in.getJSONObject("authenticatorSelection").getString("userVerification"));
    }

    @Test
    public void creationRequestAddsAuthenticatorSelectionWhenMissing() throws Exception {
        JSONObject in = creationOptions(PasskeyJson.RP_ID);
        in.remove("authenticatorSelection");
        JSONObject out = new JSONObject(PasskeyJson.creationRequest(in, PasskeyJson.RP_ID));
        assertEquals("required", out.getJSONObject("authenticatorSelection").getString("userVerification"));
    }

    @Test
    public void creationRequestRejectsOtherRelyingPartyAndBadOptions() throws Exception {
        assertThrows(PasskeyJson.WrongRelyingParty.class,
            () -> PasskeyJson.creationRequest(creationOptions("localhost"), PasskeyJson.RP_ID));
        JSONObject noUserId = creationOptions(PasskeyJson.RP_ID);
        noUserId.getJSONObject("user").remove("id");
        assertThrows(PasskeyJson.BadOptions.class, () -> PasskeyJson.creationRequest(noUserId, PasskeyJson.RP_ID));
        JSONObject badUserId = creationOptions(PasskeyJson.RP_ID);
        badUserId.getJSONObject("user").put("id", "not base64url!");
        assertThrows(PasskeyJson.BadOptions.class, () -> PasskeyJson.creationRequest(badUserId, PasskeyJson.RP_ID));
        JSONObject noRp = creationOptions(PasskeyJson.RP_ID);
        noRp.remove("rp");
        assertThrows(PasskeyJson.BadOptions.class, () -> PasskeyJson.creationRequest(noRp, PasskeyJson.RP_ID));
    }

    @Test
    public void assertionRequestForcesUserVerificationAndChecksRp() throws Exception {
        JSONObject out = new JSONObject(PasskeyJson.assertionRequest(requestOptions(PasskeyJson.RP_ID), PasskeyJson.RP_ID));
        assertEquals("required", out.getString("userVerification"));
        assertEquals(CHALLENGE, out.getString("challenge"));
        assertThrows(PasskeyJson.WrongRelyingParty.class,
            () -> PasskeyJson.assertionRequest(requestOptions("localhost"), PasskeyJson.RP_ID));
        JSONObject noRp = requestOptions(PasskeyJson.RP_ID);
        noRp.remove("rpId");
        assertThrows(PasskeyJson.BadOptions.class, () -> PasskeyJson.assertionRequest(noRp, PasskeyJson.RP_ID));
    }

    @Test
    public void registrationCredentialHasExactlyTheSchemaKeys() throws Exception {
        // What Credential Manager returns (padded ids and extra fields included on purpose).
        JSONObject cm = new JSONObject()
            .put("id", "-_-_PgAB")
            .put("rawId", "-_-_PgAB==")
            .put("type", "public-key")
            .put("authenticatorAttachment", "platform")
            .put("response", new JSONObject()
                .put("clientDataJSON", "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0")
                .put("attestationObject", "o2NmbXQ")
                .put("transports", new JSONArray().put("internal").put("hybrid").put("bogus"))
                .put("publicKey", "MFkw")
                .put("publicKeyAlgorithm", -7)
                .put("authenticatorData", "AAAA"))
            .put("clientExtensionResults", new JSONObject().put("credProps", new JSONObject().put("rk", true)));
        JSONObject out = PasskeyJson.credential(cm, true);
        assertEquals(new HashSet<>(Arrays.asList("id", "rawId", "type", "response", "authenticatorAttachment", "clientExtensionResults")),
            PasskeyJson.keys(out));
        assertEquals("-_-_PgAB", out.getString("id"));
        assertEquals("-_-_PgAB", out.getString("rawId"));
        assertEquals("public-key", out.getString("type"));
        assertEquals("platform", out.getString("authenticatorAttachment"));
        JSONObject res = out.getJSONObject("response");
        assertEquals(new HashSet<>(Arrays.asList("clientDataJSON", "attestationObject", "transports")), PasskeyJson.keys(res));
        assertEquals("eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0", res.getString("clientDataJSON"));
        assertEquals("o2NmbXQ", res.getString("attestationObject"));
        assertEquals("[\"internal\",\"hybrid\"]", res.getJSONArray("transports").toString());
        assertTrue(out.getJSONObject("clientExtensionResults").getJSONObject("credProps").getBoolean("rk"));
        assertFalse(out.toString().contains("="));
    }

    @Test
    public void assertionCredentialReturnsUserHandleVerbatim() throws Exception {
        byte[] authData = new byte[37];
        authData[32] = 0x05; // UP | UV
        JSONObject cm = new JSONObject()
            .put("id", "AQID")
            .put("rawId", "AQID")
            .put("type", "public-key")
            .put("response", new JSONObject()
                .put("clientDataJSON", "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0")
                .put("authenticatorData", b64url(authData))
                .put("signature", "MEUCIQ")
                .put("userHandle", USER_ID));
        JSONObject out = PasskeyJson.credential(cm, false);
        JSONObject res = out.getJSONObject("response");
        assertEquals(new HashSet<>(Arrays.asList("clientDataJSON", "authenticatorData", "signature", "userHandle")), PasskeyJson.keys(res));
        assertEquals(USER_ID, res.getString("userHandle"));
        assertEquals(UUID, new String(Base64.getUrlDecoder().decode(res.getString("userHandle")), StandardCharsets.UTF_8));
        assertEquals(0x04, Base64.getUrlDecoder().decode(res.getString("authenticatorData"))[32] & 0x04);
        assertEquals("{}", out.getJSONObject("clientExtensionResults").toString());
        assertFalse(out.has("authenticatorAttachment"));
    }

    @Test
    public void assertionCredentialNullUserHandleAndMissingFields() throws Exception {
        JSONObject cm = new JSONObject()
            .put("id", "AQID")
            .put("type", "public-key")
            .put("response", new JSONObject()
                .put("clientDataJSON", "eyJ9")
                .put("authenticatorData", "AAAA")
                .put("signature", "MEUCIQ")
                .put("userHandle", JSONObject.NULL));
        JSONObject out = PasskeyJson.credential(cm, false);
        assertTrue(out.getJSONObject("response").isNull("userHandle"));
        assertEquals("AQID", out.getString("rawId"));

        JSONObject noSignature = new JSONObject(cm.toString());
        noSignature.getJSONObject("response").remove("signature");
        assertThrows(PasskeyJson.BadOptions.class, () -> PasskeyJson.credential(noSignature, false));
        JSONObject standardAlphabet = new JSONObject(cm.toString());
        standardAlphabet.put("id", "+/+/");
        assertThrows(PasskeyJson.BadOptions.class, () -> PasskeyJson.credential(standardAlphabet, false));
        JSONObject wrongType = new JSONObject(cm.toString());
        wrongType.put("type", "password");
        assertThrows(PasskeyJson.BadOptions.class, () -> PasskeyJson.credential(wrongType, false));
    }

    @Test
    public void base64UrlValidation() throws Exception {
        assertTrue(PasskeyJson.isBase64Url("AQID"));
        assertTrue(PasskeyJson.isBase64Url("AQ=="));
        assertTrue(PasskeyJson.isBase64Url("-_"));
        assertFalse(PasskeyJson.isBase64Url(""));
        assertFalse(PasskeyJson.isBase64Url(null));
        assertFalse(PasskeyJson.isBase64Url("A"));
        assertFalse(PasskeyJson.isBase64Url("+/"));
        assertFalse(PasskeyJson.isBase64Url("A=B"));
        assertEquals("AQ", PasskeyJson.base64Url("AQ=="));
    }
}
