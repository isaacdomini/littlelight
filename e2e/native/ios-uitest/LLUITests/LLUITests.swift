import XCTest

// Minimal XCUITest driver for the iOS native gate (e2e/native/ios-gate.sh). It exists because
// simctl cannot grant the notification permission, tap a banner, or see inside the WKWebView.
// It has no host app: it drives the installed Littlelight app and SpringBoard by bundle id.
// Inputs come from `TEST_RUNNER_LL_*` environment variables of the xcodebuild invocation.
final class LLUITests: XCTestCase {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let app = XCUIApplication(bundleIdentifier: "com.tesarsoft.littlelight")

    private func env(_ k: String) -> String? {
        let v = ProcessInfo.processInfo.environment[k]
        return (v?.isEmpty ?? true) ? nil : v
    }

    private func dump(_ name: String) {
        guard let dir = env("LL_OUT") else { return }
        try? app.debugDescription.write(toFile: "\(dir)/\(name).txt", atomically: true, encoding: .utf8)
    }

    /// Any element of the app whose label contains `text` (case-insensitive).
    private func element(containing text: String) -> XCUIElement {
        let pred = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", text, text)
        return app.descendants(matching: .any).matching(pred).firstMatch
    }

    /// The system notification permission alert: tap Allow.
    func testAllowPrompt() throws {
        let allow = springboard.alerts.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 30), "no notification permission prompt")
        allow.tap()
    }

    /// With the app in the background, tap the banner whose text contains LL_BANNER.
    /// The shell sends the `simctl push` once this test is running.
    func testTapBanner() throws {
        let text = env("LL_BANNER") ?? "Littlelight"
        XCUIDevice.shared.press(.home)
        sleep(3)
        let pred = NSPredicate(format: "label CONTAINS[c] %@", text)
        let banner = springboard.descendants(matching: .any).matching(pred).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 60), "no banner containing \(text)")
        banner.tap()
    }

    /// Bring the app forward and wait for text from LL_EXPECT inside the web view.
    func testExpectText() throws {
        let text = try XCTUnwrap(env("LL_EXPECT"), "LL_EXPECT not set")
        // `simctl openurl littlelight://...` raises SpringBoard's "Open in Littlelight?" alert.
        let open = springboard.alerts.buttons["Open"]
        if open.waitForExistence(timeout: 8) { open.tap() }
        app.activate()
        let found = element(containing: text).waitForExistence(timeout: 30)
        dump("expect")
        XCTAssertTrue(found, "text not found in the app: \(text)")
    }


    /// Signed in: Settings -> Notifications -> "Turn on notifications" -> system alert -> Allow.
    func testEnablePush() throws {
        app.activate()
        let settings = app.webViews.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 30), "no Settings button (signed in?)")
        settings.tap()
        let row = element(containing: "Notifications")
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no Notifications row")
        row.tap()
        let enable = app.webViews.buttons["Turn on notifications"]
        XCTAssertTrue(enable.waitForExistence(timeout: 20), "no 'Turn on notifications' button")
        enable.tap()
        let allow = springboard.alerts.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 30), "no notification permission prompt")
        allow.tap()
        XCTAssertTrue(element(containing: "Notifications are on for this device").waitForExistence(timeout: 30), "page did not show the enabled state")
        dump("enable-push")
    }


    /// Make sure the app is signed out: no-op on the welcome page.
    func testSignOut() throws {
        app.activate()
        if element(containing: "Welcome to Littlelight").waitForExistence(timeout: 15) { return }
        let settings = app.webViews.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 20), "neither the welcome page nor Settings is showing")
        settings.tap()
        let out = element(containing: "Sign out of this device")
        XCTAssertTrue(out.waitForExistence(timeout: 20), "no sign-out row")
        out.tap()
        sleep(1)
        let confirm = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Sign out'")).element(boundBy: 0)
        if confirm.waitForExistence(timeout: 5) && !element(containing: "Welcome to Littlelight").exists { confirm.tap() }
        XCTAssertTrue(element(containing: "Welcome to Littlelight").waitForExistence(timeout: 30), "still signed in")
        dump("signed-out")
    }

    /// In the shared album (opened by deep link): tap "Done" and check the app lands on its start
    /// page (Welcome when signed out) and does not bounce back into the share viewer.
    func testShareDone() throws {
        app.activate()
        let done = app.webViews.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 30), "no Done button in the share viewer")
        done.tap()
        XCTAssertTrue(element(containing: "Welcome to Littlelight").waitForExistence(timeout: 30), "Done did not land on the start page")
        sleep(5)
        XCTAssertTrue(element(containing: "Welcome to Littlelight").exists, "bounced back after Done")
        XCTAssertFalse(done.exists, "back in the share viewer after Done")
        dump("share-done")
    }

    /// Dump the accessibility tree (debugging aid).
    func testDump() throws {
        app.activate()
        sleep(3)
        dump(env("LL_DUMP_NAME") ?? "tree")
    }

    /// Sign in through the real UI: LL_EMAIL, code read from Mailpit (LL_MAILPIT).
    func testSignIn() throws {
        let email = try XCTUnwrap(env("LL_EMAIL"), "LL_EMAIL not set")
        app.activate()
        let field = app.webViews.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 30), "no email field")
        field.tap()
        field.typeText(email)
        dump("signin-1")
        app.webViews.buttons["Continue with email"].tap()
        let code = try mailCode(for: email)
        let codeField = app.webViews.textFields.firstMatch
        XCTAssertTrue(codeField.waitForExistence(timeout: 20), "no code field")
        codeField.tap()
        codeField.typeText(code)
        sleep(4)
        dump("signin-2")
    }

    private func mailCode(for email: String) throws -> String {
        let base = env("LL_MAILPIT") ?? "http://localhost:8025"
        for _ in 0..<30 {
            if let id = fetch("\(base)/api/v1/search?query=to:\(email)").flatMap({ ($0["messages"] as? [[String: Any]])?.first?["ID"] as? String }),
               let msg = fetch("\(base)/api/v1/message/\(id)"),
               let html = msg["HTML"] as? String,
               let r = html.range(of: ">[0-9]{6}<", options: .regularExpression) {
                return String(html[r].dropFirst().dropLast())
            }
            sleep(1)
        }
        throw XCTSkip("no code in Mailpit")
    }

    private func fetch(_ url: String) -> [String: Any]? {
        guard let u = URL(string: url) else { return nil }
        var out: [String: Any]?
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: u) { d, _, _ in
            if let d = d { out = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] }
            sem.signal()
        }.resume()
        sem.wait()
        return out
    }
}
