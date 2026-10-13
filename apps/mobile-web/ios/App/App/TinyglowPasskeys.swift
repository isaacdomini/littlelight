import Foundation
import Capacitor
import AuthenticationServices

// Passkeys (docs/plans/step-13.md 2.6): the platform ceremonies behind "Sign in with a passkey" and
// "Add a passkey", so the relying party is `tinyglow.app` (the WebView origin capacitor://localhost can
// never be a WebAuthn origin). JSON in and out is the W3C form the API already speaks; the pure
// mapping lives in LLPasskeyCodec.swift.
//
// Bridge `TinyglowPasskeys` (iOS 16+; the deployment target is 15, so every path is guarded):
//   available()                                   -> { available }
//        true when the OS is iOS 16+ and the embedded provisioning profile grants
//        `webcredentials:tinyglow.app` (device builds signed with the Team ID, Part B P1).
//        Simulator and ad-hoc builds: false, no OS call, no crash.
//   create({ options })                           -> { credential }
//        options: PublicKeyCredentialCreationOptionsJSON from POST /api/me/passkeys/options.
//        ASAuthorizationPlatformPublicKeyCredentialProvider.createCredentialRegistrationRequest,
//        userVerificationPreference .required; excludedCredentials on iOS 17.4+.
//   get({ options, preferImmediatelyAvailable? })  -> { credential }
//        options: PublicKeyCredentialRequestOptionsJSON from POST /api/auth/passkey/options.
//        createCredentialAssertionRequest with allowedCredentials; preferImmediatelyAvailable: true
//        (the explicit button) skips the "no passkey here" sheet and reports `cancelled` instead.
//   credential: PublicKeyCredential JSON (id, rawId, type, response.{clientDataJSON,
//        attestationObject | authenticatorData, signature, userHandle}, authenticatorAttachment
//        "platform", clientExtensionResults {}), base64url unpadded; userHandle verbatim.
//
// Rejections (CAPPluginCall.reject(message, code); the message equals the code, nothing from the OS):
//   cancelled      the user dismissed the sheet, or no passkey with preferImmediatelyAvailable
//   not_available  iOS < 16
//   not_configured the options name another RP than tinyglow.app (dev stack), or the app is not
//                  associated with the domain (no Team ID / AASA not served yet)
//   failed         anything else (malformed options, authenticator error, a ceremony already running)
//
// Privacy: options, challenges, credential ids, user handles and OS error messages are never logged.

enum LLPasskeyFailure: String, Error {
    case cancelled, notAvailable = "not_available", notConfigured = "not_configured", failed
}

@available(iOS 16.0, *)
final class LLPasskeyCeremony: NSObject, ASAuthorizationControllerDelegate,
                               ASAuthorizationControllerPresentationContextProviding {
    private let anchor: ASPresentationAnchor
    private let completion: (Result<[String: Any], LLPasskeyFailure>) -> Void
    private var controller: ASAuthorizationController?

    init(anchor: ASPresentationAnchor, completion: @escaping (Result<[String: Any], LLPasskeyFailure>) -> Void) {
        self.anchor = anchor
        self.completion = completion
        super.init()
    }

    func perform(_ request: ASAuthorizationRequest, preferImmediatelyAvailable: Bool) {
        let c = ASAuthorizationController(authorizationRequests: [request])
        c.delegate = self
        c.presentationContextProvider = self
        controller = c
        if preferImmediatelyAvailable {
            c.performRequests(options: .preferImmediatelyAvailableCredentials)
        } else {
            c.performRequests()
        }
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { anchor }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithAuthorization authorization: ASAuthorization) {
        switch authorization.credential {
        case let reg as ASAuthorizationPlatformPublicKeyCredentialRegistration:
            completion(.success(LLPasskeyCodec.registrationJSON(
                credentialId: reg.credentialID,
                clientDataJSON: reg.rawClientDataJSON,
                attestationObject: reg.rawAttestationObject
            )))
        case let assertion as ASAuthorizationPlatformPublicKeyCredentialAssertion:
            completion(.success(LLPasskeyCodec.assertionJSON(
                credentialId: assertion.credentialID,
                clientDataJSON: assertion.rawClientDataJSON,
                authenticatorData: assertion.rawAuthenticatorData,
                signature: assertion.signature,
                userHandle: assertion.userID
            )))
        default:
            completion(.failure(.failed))
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        completion(.failure(Self.classify(error)))
    }

    /// ASAuthorizationError.canceled -> cancelled. `.failed` carries "not associated with domain" when
    /// the AASA/entitlement pair is missing -> not_configured. Everything else -> failed. The text is
    /// matched, never forwarded.
    static func classify(_ error: Error) -> LLPasskeyFailure {
        let ns = error as NSError
        guard ns.domain == ASAuthorizationErrorDomain else { return .failed }
        switch ASAuthorizationError.Code(rawValue: ns.code) {
        case .canceled:
            return .cancelled
        case .failed:
            let text = (ns.localizedDescription + " " + (ns.userInfo[NSDebugDescriptionErrorKey] as? String ?? "")).lowercased()
            return text.contains("not associated with domain") ? .notConfigured : .failed
        default:
            return .failed
        }
    }
}

@objc(TinyglowPasskeysPlugin)
public class TinyglowPasskeysPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TinyglowPasskeysPlugin"
    public let jsName = "TinyglowPasskeys"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
    ]

    private var active: AnyObject?

    @objc func available(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else { call.resolve(["available": false]); return }
        call.resolve(["available": LLProvisioningProfile.grantsWebCredentials(for: LLPasskeyCodec.relyingPartyId)])
    }

    @objc func create(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else { reject(call, .notAvailable); return }
        guard let options = call.getObject("options") else { reject(call, .failed); return }
        let creation: LLPasskeyCreation
        do {
            creation = try LLPasskeyCodec.creation(from: options)
        } catch {
            reject(call, error as? LLPasskeyError == .wrongRelyingParty ? .notConfigured : .failed)
            return
        }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: LLPasskeyCodec.relyingPartyId)
        let request = provider.createCredentialRegistrationRequest(
            challenge: creation.challenge, name: creation.userName, userID: creation.userId
        )
        request.userVerificationPreference = .required
        if #available(iOS 17.4, *) {
            request.excludedCredentials = creation.excludeCredentialIds.map {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
            }
        }
        run(call, request, preferImmediatelyAvailable: false)
    }

    @objc func get(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else { reject(call, .notAvailable); return }
        guard let options = call.getObject("options") else { reject(call, .failed); return }
        let assertion: LLPasskeyAssertionRequest
        do {
            assertion = try LLPasskeyCodec.assertionRequest(from: options)
        } catch {
            reject(call, error as? LLPasskeyError == .wrongRelyingParty ? .notConfigured : .failed)
            return
        }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: LLPasskeyCodec.relyingPartyId)
        let request = provider.createCredentialAssertionRequest(challenge: assertion.challenge)
        request.userVerificationPreference = .required
        request.allowedCredentials = assertion.allowCredentialIds.map {
            ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
        }
        run(call, request, preferImmediatelyAvailable: call.getBool("preferImmediatelyAvailable") ?? false)
    }

    @available(iOS 16.0, *)
    private func run(_ call: CAPPluginCall, _ request: ASAuthorizationRequest, preferImmediatelyAvailable: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.active == nil else { self.reject(call, .failed); return }
            let anchor = self.bridge?.viewController?.view.window ?? ASPresentationAnchor()
            let ceremony = LLPasskeyCeremony(anchor: anchor) { [weak self] result in
                self?.active = nil
                switch result {
                case .success(let credential): call.resolve(["credential": credential])
                case .failure(let failure): self?.reject(call, failure)
                }
            }
            self.active = ceremony
            ceremony.perform(request, preferImmediatelyAvailable: preferImmediatelyAvailable)
        }
    }

    private func reject(_ call: CAPPluginCall, _ failure: LLPasskeyFailure) {
        call.reject(failure.rawValue, failure.rawValue)
    }
}
