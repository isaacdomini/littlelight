import Foundation

// Foundation-only half of the TinyglowPasskeys plugin (docs/plans/step-13.md 2.6): base64url, the
// pieces of the W3C options JSON the platform API needs, and the credential JSON the API expects
// (packages/shared/src/api/auth.ts `publicKeyCredentialJsonSchema`: base64url without padding,
// `clientExtensionResults` may be `{}`). No AuthenticationServices import, so the host-side harness
// (ios/scripts/passkey-codec-harness.sh) compiles and runs it with swiftc in a few seconds.
//
// Decision h (step-13.md 0.1): GoTrue's registration `options.user.id` is the base64url of the
// 36-char UUID string. It is decoded to bytes for the OS and never interpreted; the assertion's
// `userHandle` is re-encoded verbatim so GoTrue can match it.
//
// Privacy: nothing here logs. Challenges, credential ids and user handles pass through as bytes.

enum LLPasskeyError: Error, Equatable {
    /// The options JSON is not what the API sends (-> plugin error `failed`).
    case badOptions
    /// The options name another relying party than the build's `tinyglow.app` (-> `not_configured`):
    /// a dev stack (RP id `localhost`) can never serve a native ceremony.
    case wrongRelyingParty
}

enum LLBase64Url {
    /// Unpadded base64url (RFC 4648 §5), the WebAuthn JSON encoding.
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Accepts padded or unpadded base64url; rejects the standard alphabet and anything else.
    static func decode(_ string: String) -> Data? {
        guard !string.isEmpty, string.unicodeScalars.allSatisfy(isUrlAlphabet) else { return nil }
        var s = string.replacingOccurrences(of: "=", with: "")
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let rem = s.count % 4
        if rem == 1 { return nil }
        if rem > 0 { s += String(repeating: "=", count: 4 - rem) }
        return Data(base64Encoded: s)
    }

    private static func isUrlAlphabet(_ c: Unicode.Scalar) -> Bool {
        switch c {
        case "A"..."Z", "a"..."z", "0"..."9", "-", "_", "=": return true
        default: return false
        }
    }
}

/// What `createCredentialRegistrationRequest(challenge:name:userID:)` needs from
/// `PublicKeyCredentialCreationOptionsJSON`.
struct LLPasskeyCreation: Equatable {
    let challenge: Data
    let userId: Data
    let userName: String
    let excludeCredentialIds: [Data]
}

/// What `createCredentialAssertionRequest(challenge:)` needs from `PublicKeyCredentialRequestOptionsJSON`.
struct LLPasskeyAssertionRequest: Equatable {
    let challenge: Data
    let allowCredentialIds: [Data]
}

enum LLPasskeyCodec {
    /// Build-time relying party id: the production host. Must equal `GOTRUE_WEBAUTHN_RP_ID` and the
    /// `webcredentials:` Associated Domain.
    static let relyingPartyId = "tinyglow.app"

    static func creation(from options: [String: Any], rpId: String = relyingPartyId) throws -> LLPasskeyCreation {
        guard let rp = options["rp"] as? [String: Any], let id = rp["id"] as? String else { throw LLPasskeyError.badOptions }
        guard id == rpId else { throw LLPasskeyError.wrongRelyingParty }
        guard let challengeString = options["challenge"] as? String, let challenge = LLBase64Url.decode(challengeString),
              let user = options["user"] as? [String: Any],
              let userIdString = user["id"] as? String, let userId = LLBase64Url.decode(userIdString),
              let userName = user["name"] as? String, !userName.isEmpty
        else { throw LLPasskeyError.badOptions }
        return LLPasskeyCreation(
            challenge: challenge,
            userId: userId,
            userName: userName,
            excludeCredentialIds: try credentialIds(options["excludeCredentials"])
        )
    }

    static func assertionRequest(from options: [String: Any], rpId: String = relyingPartyId) throws -> LLPasskeyAssertionRequest {
        guard let id = options["rpId"] as? String else { throw LLPasskeyError.badOptions }
        guard id == rpId else { throw LLPasskeyError.wrongRelyingParty }
        guard let challengeString = options["challenge"] as? String, let challenge = LLBase64Url.decode(challengeString)
        else { throw LLPasskeyError.badOptions }
        return LLPasskeyAssertionRequest(challenge: challenge, allowCredentialIds: try credentialIds(options["allowCredentials"]))
    }

    /// `PublicKeyCredentialDescriptorJSON[]` -> raw ids. Absent or empty is fine; a malformed entry is not.
    private static func credentialIds(_ value: Any?) throws -> [Data] {
        guard let value = value else { return [] }
        guard let list = value as? [[String: Any]] else { throw LLPasskeyError.badOptions }
        return try list.map { entry in
            guard let s = entry["id"] as? String, let d = LLBase64Url.decode(s) else { throw LLPasskeyError.badOptions }
            return d
        }
    }

    /// `ASAuthorizationPlatformPublicKeyCredentialRegistration` -> `PublicKeyCredential` JSON.
    static func registrationJSON(credentialId: Data, clientDataJSON: Data, attestationObject: Data?) -> [String: Any] {
        var response: [String: Any] = ["clientDataJSON": LLBase64Url.encode(clientDataJSON), "transports": ["internal"]]
        if let attestationObject = attestationObject { response["attestationObject"] = LLBase64Url.encode(attestationObject) }
        return credential(credentialId: credentialId, response: response)
    }

    /// `ASAuthorizationPlatformPublicKeyCredentialAssertion` -> `PublicKeyCredential` JSON. `userHandle`
    /// is the authenticator's bytes re-encoded, nothing else (decision h); empty -> null.
    static func assertionJSON(credentialId: Data, clientDataJSON: Data, authenticatorData: Data,
                              signature: Data, userHandle: Data?) -> [String: Any] {
        var response: [String: Any] = [
            "clientDataJSON": LLBase64Url.encode(clientDataJSON),
            "authenticatorData": LLBase64Url.encode(authenticatorData),
            "signature": LLBase64Url.encode(signature),
        ]
        if let h = userHandle, !h.isEmpty { response["userHandle"] = LLBase64Url.encode(h) } else { response["userHandle"] = NSNull() }
        return credential(credentialId: credentialId, response: response)
    }

    private static func credential(credentialId: Data, response: [String: Any]) -> [String: Any] {
        let id = LLBase64Url.encode(credentialId)
        return [
            "id": id,
            "rawId": id,
            "type": "public-key",
            "response": response,
            "authenticatorAttachment": "platform",
            "clientExtensionResults": [String: Any](),
        ]
    }
}

/// Reads the Associated Domains the embedded provisioning profile grants. Device builds (development,
/// TestFlight, App Store) carry `embedded.mobileprovision`; simulator builds do not, so there
/// `grantsWebCredentials` is false and the plugin reports `available: false` (no crash, no OS call).
enum LLProvisioningProfile {
    static let entitlementKey = "com.apple.developer.associated-domains"

    /// The profile is a CMS envelope around an XML plist; the plist is located by its markers.
    static func associatedDomains(in blob: Data) -> [String]? {
        guard let start = blob.range(of: Data("<?xml".utf8)),
              let end = blob.range(of: Data("</plist>".utf8), in: start.lowerBound..<blob.endIndex)
        else { return nil }
        let plist = blob.subdata(in: start.lowerBound..<end.upperBound)
        guard let root = try? PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any],
              let entitlements = root["Entitlements"] as? [String: Any]
        else { return nil }
        return entitlements[entitlementKey] as? [String] ?? []
    }

    /// True when the profile lists `webcredentials:<host>` (any `?mode=` suffix accepted).
    static func grantsWebCredentials(for host: String, domains: [String]?) -> Bool {
        guard let domains = domains else { return false }
        return domains.contains { d in
            d == "webcredentials:\(host)" || d.hasPrefix("webcredentials:\(host)?")
        }
    }

    static func grantsWebCredentials(for host: String) -> Bool {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let blob = try? Data(contentsOf: url)
        else { return false }
        return grantsWebCredentials(for: host, domains: associatedDomains(in: blob))
    }
}
