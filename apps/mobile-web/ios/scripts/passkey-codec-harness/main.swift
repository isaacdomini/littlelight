import Foundation

// Host-side test of LLPasskeyCodec (ios/App/App/LLPasskeyCodec.swift), docs/plans/step-13.md 13.6:
// base64url (unpadded out, padded or unpadded in, URL alphabet only), the options the OS needs,
// the opaque pass-through of GoTrue's `user.id` (decision h), the credential JSON shape the API
// validates (publicKeyCredentialJsonSchema), `userHandle` verbatim, the RP-id check and the
// provisioning-profile reader behind `available()`. Run: sh apps/mobile-web/ios/scripts/passkey-codec-harness.sh

var failures = 0
func check(_ name: String, _ ok: Bool) {
    print("\(ok ? "PASS" : "FAIL") \(name)")
    if !ok { failures += 1 }
}

// base64url
let bytes = Data([0xfb, 0xff, 0xbf, 0x3e, 0x00, 0x01])  // encodes to +/ in standard base64
let enc = LLBase64Url.encode(bytes)
check("encode uses -_ and no padding", enc == "-_-_PgAB" && !enc.contains("=") && !enc.contains("+") && !enc.contains("/"))
check("decode unpadded", LLBase64Url.decode("-_-_PgAB") == bytes)
check("decode padded", LLBase64Url.decode("AQ==") == Data([1]) && LLBase64Url.decode("AQ") == Data([1]))
check("decode rejects standard alphabet", LLBase64Url.decode("+/-_") == nil)
check("decode rejects empty and bad length", LLBase64Url.decode("") == nil && LLBase64Url.decode("A") == nil)
for n in 1..<70 {
    let d = Data((0..<n).map { UInt8(truncatingIfNeeded: $0 &* 37 &+ 11) })
    if LLBase64Url.decode(LLBase64Url.encode(d)) != d { check("roundtrip length \(n)", false) }
}
check("roundtrip lengths 1..69", true)

// Registration options as GoTrue sends them (0.1): user.id = base64url("<36-char uuid>")
let uuid = "550e8400-e29b-41d4-a716-446655440000"
let userIdB64 = LLBase64Url.encode(Data(uuid.utf8))
let challenge = Data((0..<32).map { UInt8($0) })
let creationOptions: [String: Any] = [
    "rp": ["id": "tinyglow.app", "name": "Tinyglow"],
    "user": ["id": userIdB64, "name": "parent@example.com", "displayName": "parent@example.com"],
    "challenge": LLBase64Url.encode(challenge),
    "pubKeyCredParams": [["type": "public-key", "alg": -7]],
    "authenticatorSelection": ["residentKey": "required", "userVerification": "preferred"],
    "attestation": "none",
    "excludeCredentials": [["type": "public-key", "id": LLBase64Url.encode(Data([9, 9, 9]))]],
]
do {
    let c = try LLPasskeyCodec.creation(from: creationOptions)
    check("creation: challenge decoded", c.challenge == challenge)
    check("creation: user.id decoded to the 36 UUID bytes, uninterpreted", c.userId == Data(uuid.utf8) && c.userId.count == 36)
    check("creation: user.name", c.userName == "parent@example.com")
    check("creation: excludeCredentials ids", c.excludeCredentialIds == [Data([9, 9, 9])])
} catch {
    check("creation parses", false)
}
var otherRp = creationOptions
otherRp["rp"] = ["id": "localhost", "name": "Tinyglow"]
check("creation: dev RP id -> wrongRelyingParty", (try? LLPasskeyCodec.creation(from: otherRp)) == nil
      && { do { _ = try LLPasskeyCodec.creation(from: otherRp); return false } catch { return error as? LLPasskeyError == .wrongRelyingParty } }())
var noUser = creationOptions
noUser["user"] = ["name": "x"]
check("creation: missing user.id -> badOptions", { do { _ = try LLPasskeyCodec.creation(from: noUser); return false } catch { return error as? LLPasskeyError == .badOptions } }())
var badExclude = creationOptions
badExclude["excludeCredentials"] = [["type": "public-key", "id": "+/"]]
check("creation: malformed excludeCredentials -> badOptions", { do { _ = try LLPasskeyCodec.creation(from: badExclude); return false } catch { return error as? LLPasskeyError == .badOptions } }())

// Assertion options
let requestOptions: [String: Any] = [
    "rpId": "tinyglow.app",
    "challenge": LLBase64Url.encode(challenge),
    "userVerification": "required",
    "allowCredentials": [],
]
do {
    let a = try LLPasskeyCodec.assertionRequest(from: requestOptions)
    check("assertion: challenge decoded, no allow list", a.challenge == challenge && a.allowCredentialIds.isEmpty)
} catch {
    check("assertion parses", false)
}
var devRequest = requestOptions
devRequest["rpId"] = "localhost"
check("assertion: dev RP id -> wrongRelyingParty", { do { _ = try LLPasskeyCodec.assertionRequest(from: devRequest); return false } catch { return error as? LLPasskeyError == .wrongRelyingParty } }())
var noRp = requestOptions
noRp.removeValue(forKey: "rpId")
check("assertion: missing rpId -> badOptions", { do { _ = try LLPasskeyCodec.assertionRequest(from: noRp); return false } catch { return error as? LLPasskeyError == .badOptions } }())

// Credential JSON: the exact publicKeyCredentialJsonSchema shape.
let credId = Data([0xfb, 0xff, 0xbf, 0x3e, 0x00, 0x01, 0x02])
let clientData = Data("{\"type\":\"webauthn.create\"}".utf8)
let attestation = Data([0xa3, 0x63, 0x66, 0x6d, 0x74])
let reg = LLPasskeyCodec.registrationJSON(credentialId: credId, clientDataJSON: clientData, attestationObject: attestation)
let regResponse = reg["response"] as? [String: Any] ?? [:]
check("registration: id == rawId == base64url(credentialID)", reg["id"] as? String == LLBase64Url.encode(credId) && reg["rawId"] as? String == reg["id"] as? String)
check("registration: type public-key, attachment platform", reg["type"] as? String == "public-key" && reg["authenticatorAttachment"] as? String == "platform")
check("registration: response fields", regResponse["clientDataJSON"] as? String == LLBase64Url.encode(clientData)
      && regResponse["attestationObject"] as? String == LLBase64Url.encode(attestation)
      && (regResponse["transports"] as? [String]) == ["internal"]
      && regResponse["authenticatorData"] == nil && regResponse["signature"] == nil && regResponse["userHandle"] == nil)
check("registration: clientExtensionResults is {}", (reg["clientExtensionResults"] as? [String: Any])?.isEmpty == true)
check("registration: exactly the schema's keys", Set(reg.keys) == ["id", "rawId", "type", "response", "authenticatorAttachment", "clientExtensionResults"])
check("registration: JSON-serialisable", JSONSerialization.isValidJSONObject(reg))
check("registration: no attestation -> key absent", (LLPasskeyCodec.registrationJSON(credentialId: credId, clientDataJSON: clientData, attestationObject: nil)["response"] as? [String: Any])?["attestationObject"] == nil)

// Assertion JSON: userHandle must be exactly what GoTrue handed out (decision h), signature/authData base64url.
let userHandle = Data(uuid.utf8)
let authData = Data([UInt8](repeating: 0, count: 32) + [0x05] + [0, 0, 0, 1])  // flags byte 0x05 = UP|UV
let signature = Data([0x30, 0x45, 0x02, 0x21])
let asr = LLPasskeyCodec.assertionJSON(credentialId: credId, clientDataJSON: clientData, authenticatorData: authData, signature: signature, userHandle: userHandle)
let asrResponse = asr["response"] as? [String: Any] ?? [:]
check("assertion: userHandle verbatim (== GoTrue's user.id)", asrResponse["userHandle"] as? String == userIdB64)
check("assertion: authenticatorData/signature base64url", asrResponse["authenticatorData"] as? String == LLBase64Url.encode(authData)
      && asrResponse["signature"] as? String == LLBase64Url.encode(signature)
      && (asrResponse["authenticatorData"] as? String).map { LLBase64Url.decode($0) == authData } == true)
check("assertion: UV flag survives the encoding", LLBase64Url.decode(asrResponse["authenticatorData"] as! String)![32] & 0x04 == 0x04)
check("assertion: no attestationObject/transports", asrResponse["attestationObject"] == nil && asrResponse["transports"] == nil)
check("assertion: empty userHandle -> null", (LLPasskeyCodec.assertionJSON(credentialId: credId, clientDataJSON: clientData, authenticatorData: authData, signature: signature, userHandle: Data())["response"] as? [String: Any])?["userHandle"] is NSNull)
check("assertion: JSON-serialisable", JSONSerialization.isValidJSONObject(asr))
if let data = try? JSONSerialization.data(withJSONObject: asr), let text = String(data: data, encoding: .utf8) {
    check("assertion: serialised JSON has no padding or standard-alphabet chars in values", !text.contains("=") && !text.contains("+") && !text.contains("/"))
}

// Provisioning profile reader (available()).
func profileBlob(_ plist: String) -> Data {
    var d = Data([0x30, 0x82, 0x0a, 0x00, 0x06, 0x09])  // CMS junk
    d.append(Data(plist.utf8))
    d.append(Data([0x00, 0x01, 0x02, 0x03]))
    return d
}
let granted = profileBlob("""
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Name</key><string>Tinyglow Dev</string>
<key>Entitlements</key><dict>
<key>application-identifier</key><string>TEAMID.app.tinyglow</string>
<key>com.apple.developer.associated-domains</key><array><string>applinks:tinyglow.app</string><string>webcredentials:tinyglow.app?mode=developer</string></array>
</dict></dict></plist>
""")
let domains = LLProvisioningProfile.associatedDomains(in: granted)
check("profile: domains parsed from the CMS envelope", domains == ["applinks:tinyglow.app", "webcredentials:tinyglow.app?mode=developer"])
check("profile: webcredentials granted (developer mode suffix accepted)", LLProvisioningProfile.grantsWebCredentials(for: "tinyglow.app", domains: domains))
check("profile: other host not granted", !LLProvisioningProfile.grantsWebCredentials(for: "example.com", domains: domains))
let applinksOnly = profileBlob("""
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Entitlements</key><dict>
<key>com.apple.developer.associated-domains</key><array><string>applinks:tinyglow.app</string></array>
</dict></dict></plist>
""")
check("profile: applinks only -> not granted", !LLProvisioningProfile.grantsWebCredentials(for: "tinyglow.app", domains: LLProvisioningProfile.associatedDomains(in: applinksOnly)))
check("profile: wildcard entitlement (*) -> no domains", LLProvisioningProfile.associatedDomains(in: profileBlob("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Entitlements</key><dict><key>com.apple.developer.associated-domains</key><string>*</string></dict></dict></plist>")) == [])
check("profile: garbage -> nil -> not available", LLProvisioningProfile.associatedDomains(in: Data([1, 2, 3])) == nil
      && !LLProvisioningProfile.grantsWebCredentials(for: "tinyglow.app", domains: nil))
check("profile: no embedded.mobileprovision in this process -> false", !LLProvisioningProfile.grantsWebCredentials(for: "tinyglow.app"))

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
