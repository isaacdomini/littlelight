import Photos
import XCTest

// Minimal XCUITest driver for the iOS native gate (e2e/native/ios-gate.sh). It exists because
// simctl cannot grant the notification permission, tap a banner, or see inside the WKWebView.
// It has no host app: it drives the installed Tinyglow app and SpringBoard by bundle id.
// Inputs come from `TEST_RUNNER_LL_*` environment variables of the xcodebuild invocation.
//
// Album-sync gate additions (e2e/native/ios-sync-gate.sh, docs/plans/step-10.md 2.12, 4.4): the
// runner itself uses PhotoKit (its bundle id app.tinyglow.uitests.xctrunner is granted Photos
// access by the shell with `simctl privacy grant`) to create, fill and shrink a user album,
// because `simctl addmedia` only fills the camera roll. Everything else is UI driving.
final class LLUITests: XCTestCase {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let app = XCUIApplication(bundleIdentifier: "app.tinyglow")

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
        let text = env("LL_BANNER") ?? "Tinyglow"
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
        // `simctl openurl tinyglow://...` raises SpringBoard's "Open in Tinyglow?" alert.
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
        if element(containing: "Welcome to Tinyglow").waitForExistence(timeout: 15) { return }
        let settings = app.webViews.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 20), "neither the welcome page nor Settings is showing")
        settings.tap()
        let out = element(containing: "Sign out of this device")
        XCTAssertTrue(out.waitForExistence(timeout: 20), "no sign-out row")
        out.tap()
        sleep(1)
        let confirm = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Sign out'")).element(boundBy: 0)
        if confirm.waitForExistence(timeout: 5) && !element(containing: "Welcome to Tinyglow").exists { confirm.tap() }
        XCTAssertTrue(element(containing: "Welcome to Tinyglow").waitForExistence(timeout: 30), "still signed in")
        dump("signed-out")
    }

    /// In the shared album (opened by deep link): tap "Done" and check the app lands on its start
    /// page (Welcome when signed out) and does not bounce back into the share viewer.
    func testShareDone() throws {
        app.activate()
        let done = app.webViews.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 30), "no Done button in the share viewer")
        done.tap()
        XCTAssertTrue(element(containing: "Welcome to Tinyglow").waitForExistence(timeout: 30), "Done did not land on the start page")
        sleep(5)
        XCTAssertTrue(element(containing: "Welcome to Tinyglow").exists, "bounced back after Done")
        XCTAssertFalse(done.exists, "back in the share viewer after Done")
        dump("share-done")
    }

    /// Drag up inside the web view from (0.5, LL_FROM) to (0.5, LL_TO), fractions of the screen
    /// height (defaults 0.80 -> 0.64). Used by the store-screenshot script to scroll the viewer's
    /// details panel.
    func testDragUp() throws {
        app.activate()
        let from = Double(env("LL_FROM") ?? "0.80") ?? 0.80
        let to = Double(env("LL_TO") ?? "0.64") ?? 0.64
        let win = app.windows.firstMatch
        let a = win.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: from))
        let b = win.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: to))
        a.press(forDuration: 0.1, thenDragTo: b)
    }

    /// Chat: type LL_ASK into the "Ask about your photos" field, send it, wait for LL_EXPECT in the
    /// answer, then put the keyboard away (store screenshots).
    func testAsk() throws {
        let ask = try XCTUnwrap(env("LL_ASK"), "LL_ASK not set")
        let expect = try XCTUnwrap(env("LL_EXPECT"), "LL_EXPECT not set")
        app.activate()
        let field = app.webViews.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 30), "chat input not found")
        enter(ask, in: field)
        let send = app.webViews.buttons["Send"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 10), "Send not found")
        send.tap()
        XCTAssertTrue(element(containing: expect).waitForExistence(timeout: 90), "answer text not found: \(expect)")
        let win = app.windows.firstMatch
        win.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.06)).tap()
        sleep(2)
        dump("ask")
    }

    /// Dump the accessibility tree (debugging aid).
    func testDump() throws {
        app.activate()
        sleep(3)
        dump(env("LL_DUMP_NAME") ?? "tree")
    }

    /// Tap a field until it really has keyboard focus (the on-screen keyboard is up), then type.
    /// A fresh simulator may start with the hardware keyboard connected, which leaves the software
    /// keyboard hidden and makes typeText fail with "no keyboard focus"; retry the tap, and as a
    /// last resort put the text on the pasteboard and paste it from the edit menu.
    private func enter(_ text: String, in field: XCUIElement) {
        for _ in 0..<5 {
            field.tap()
            if app.keyboards.firstMatch.waitForExistence(timeout: 3) {
                field.typeText(text)
                return
            }
            sleep(1)
        }
        UIPasteboard.general.string = text
        field.press(forDuration: 1.2)
        for label in ["Paste", "Einsetzen"] {
            let item = app.menuItems[label]
            if item.waitForExistence(timeout: 3) { item.tap(); return }
        }
        field.typeText(text)
    }

    /// Sign in through the real UI: LL_EMAIL, code read from Mailpit (LL_MAILPIT).
    func testSignIn() throws {
        let email = try XCTUnwrap(env("LL_EMAIL"), "LL_EMAIL not set")
        app.activate()
        let field = app.webViews.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 30), "no email field")
        enter(email, in: field)
        dump("signin-1")
        app.webViews.buttons["Continue with email"].tap()
        let code = try mailCode(for: email)
        let codeField = app.webViews.textFields.firstMatch
        XCTAssertTrue(codeField.waitForExistence(timeout: 20), "no code field")
        enter(code, in: codeField)
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

    // ------------------------------------------------------------------------------------------
    // Album sync (step 10)
    // ------------------------------------------------------------------------------------------

    private func ensurePhotosAccess() throws {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .authorized { return }
        let sem = DispatchSemaphore(value: 0)
        var result = PHAuthorizationStatus.notDetermined
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { s in result = s; sem.signal() }
        let alert = springboard.alerts.firstMatch
        if alert.waitForExistence(timeout: 5) {
            let b = alert.buttons["Allow Full Access"]
            if b.exists { b.tap() } else { alert.buttons.element(boundBy: 0).tap() }
        }
        _ = sem.wait(timeout: .now() + 20)
        XCTAssertEqual(result, .authorized, "the UI-test runner has no Photos access (simctl privacy grant photos app.tinyglow.uitests.xctrunner)")
    }

    private func album(named title: String) -> PHAssetCollection? {
        let o = PHFetchOptions()
        o.predicate = NSPredicate(format: "title = %@", title)
        return PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: o).firstObject
    }

    private func newestAssets(limit: Int, excluding: Set<String> = []) -> [PHAsset] {
        let o = PHFetchOptions()
        o.sortDescriptors = [NSSortDescriptor(key: "addedDate", ascending: false), NSSortDescriptor(key: "creationDate", ascending: false)]
        o.predicate = NSPredicate(format: "mediaType = %d", PHAssetMediaType.image.rawValue)
        let all = PHAsset.fetchAssets(with: o)
        var out: [PHAsset] = []
        all.enumerateObjects { a, _, stop in
            if excluding.contains(a.localIdentifier) { return }
            out.append(a)
            if out.count >= limit { stop.pointee = true }
        }
        return out
    }

    private func assetIds(in c: PHAssetCollection) -> Set<String> {
        var ids = Set<String>()
        PHAsset.fetchAssets(in: c, options: nil).enumerateObjects { a, _, _ in ids.insert(a.localIdentifier) }
        return ids
    }

    /// LL_ALBUM (title), LL_ALBUM_COUNT (default 1): create the album when missing, then add the
    /// LL_ALBUM_COUNT most recently added library photos that are not in it yet. LL_ALBUM_RESET=1
    /// deletes an existing album of that title first (the photos stay in the library).
    func testCreateAlbum() throws {
        let title = try XCTUnwrap(env("LL_ALBUM"), "LL_ALBUM not set")
        let count = Int(env("LL_ALBUM_COUNT") ?? "1") ?? 1
        try ensurePhotosAccess()
        if env("LL_ALBUM_RESET") == "1", let old = album(named: title) {
            try PHPhotoLibrary.shared().performChangesAndWait { PHAssetCollectionChangeRequest.deleteAssetCollections([old] as NSArray) }
        }
        if album(named: title) == nil {
            try PHPhotoLibrary.shared().performChangesAndWait { _ = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: title) }
        }
        let a = try XCTUnwrap(album(named: title), "album was not created")
        let toAdd = newestAssets(limit: count, excluding: assetIds(in: a))
        XCTAssertFalse(toAdd.isEmpty, "no photo to add: addmedia first")
        try PHPhotoLibrary.shared().performChangesAndWait {
            PHAssetCollectionChangeRequest(for: a)?.addAssets(toAdd as NSArray)
        }
        XCTAssertEqual(PHAsset.fetchAssets(in: a, options: nil).count, assetIds(in: a).count)
        if let dir = env("LL_OUT") {
            try? "\(PHAsset.fetchAssets(in: a, options: nil).count)".write(toFile: "\(dir)/album-count.txt", atomically: true, encoding: .utf8)
        }
    }

    /// LL_ALBUM, LL_ALBUM_REMOVE_COUNT (default 1): remove the most recently added photos from the
    /// album (they stay in the library; nothing is deleted).
    func testRemoveFromAlbum() throws {
        let title = try XCTUnwrap(env("LL_ALBUM"), "LL_ALBUM not set")
        let count = Int(env("LL_ALBUM_REMOVE_COUNT") ?? "1") ?? 1
        try ensurePhotosAccess()
        let a = try XCTUnwrap(album(named: title), "no such album")
        let o = PHFetchOptions()
        o.sortDescriptors = [NSSortDescriptor(key: "addedDate", ascending: false)]
        var victims: [PHAsset] = []
        PHAsset.fetchAssets(in: a, options: o).enumerateObjects { x, _, stop in
            victims.append(x)
            if victims.count >= count { stop.pointee = true }
        }
        try PHPhotoLibrary.shared().performChangesAndWait {
            PHAssetCollectionChangeRequest(for: a)?.removeAssets(victims as NSArray)
        }
    }

    /// Home, a pause, then back to the app (the foreground event that triggers a resume sync).
    func testBackgroundResume() throws {
        XCUIDevice.shared.press(.home)
        sleep(3)
        app.activate()
        sleep(2)
    }

    /// Tap the first element whose label contains LL_TAP; then (optionally) wait for LL_EXPECT.
    /// Tap a point of the app by normalized offset (LL_X, LL_Y in 0...1): for controls that have
    /// no accessible label (e.g. the video viewer's play overlay).
    func testTapAt() throws {
        let x = Double(env("LL_X") ?? "0.5") ?? 0.5
        let y = Double(env("LL_Y") ?? "0.5") ?? 0.5
        app.activate()
        app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
        sleep(UInt32(env("LL_SLEEP") ?? "2") ?? 2)
        dump("tap-at")
    }

    func testTapText() throws {
        let tap = try XCTUnwrap(env("LL_TAP"), "LL_TAP not set")
        app.activate()
        let el = element(containing: tap)
        XCTAssertTrue(el.waitForExistence(timeout: 30), "nothing to tap containing \(tap)")
        el.tap()
        if let expect = env("LL_EXPECT") {
            let found = element(containing: expect).waitForExistence(timeout: Double(env("LL_TIMEOUT") ?? "60") ?? 60)
            dump("tap-text")
            XCTAssertTrue(found, "text not found after tapping \(tap): \(expect)")
        }
    }

    /// Open the sync card's page: Settings -> Photo import (from wherever the app is).
    func testOpenPhotoImport() throws {
        app.activate()
        let settings = app.webViews.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 30), "no Settings button (signed in?)")
        settings.tap()
        let row = element(containing: "Photo import")
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no Photo import row")
        row.tap()
        XCTAssertTrue(element(containing: "Album sync").waitForExistence(timeout: 20), "no Album sync card")
        dump("photo-import")
    }

    /// Settings -> Photo import -> Set up -> "Allow access to Photos" -> system alert "Allow Full
    /// Access" -> album LL_ALBUM -> Start syncing -> wait for LL_EXPECT (default "imported").
    func testEnableSync() throws {
        let title = try XCTUnwrap(env("LL_ALBUM"), "LL_ALBUM not set")
        try testOpenPhotoImport()
        let setup = app.webViews.buttons["Set up"]
        XCTAssertTrue(setup.waitForExistence(timeout: 20), "no Set up button")
        setup.tap()
        let allow = app.webViews.buttons["Allow access to Photos"]
        XCTAssertTrue(allow.waitForExistence(timeout: 20), "no 'Allow access to Photos' button")
        // No system prompt may exist before the button is tapped.
        XCTAssertFalse(springboard.alerts.firstMatch.exists, "a system alert appeared before the user asked for access")
        allow.tap()
        let full = springboard.alerts.buttons["Allow Full Access"]
        XCTAssertTrue(full.waitForExistence(timeout: 30), "no 'Allow Full Access' button in the Photos prompt")
        full.tap()
        let albumRow = element(containing: title)
        XCTAssertTrue(albumRow.waitForExistence(timeout: 30), "album \(title) not listed")
        dump("albums")
        albumRow.tap()
        let start = app.webViews.buttons["Start syncing"]
        XCTAssertTrue(start.waitForExistence(timeout: 10), "no Start syncing button")
        start.tap()
        let expect = env("LL_EXPECT") ?? "imported"
        XCTAssertTrue(element(containing: expect).waitForExistence(timeout: Double(env("LL_TIMEOUT") ?? "120") ?? 120), "sync did not show \(expect)")
        dump("sync-started")
    }

    // ------------------------------------------------------------------------------------------
    // Video upload live check (step 12, NATIVE.md "Video upload live check")
    // ------------------------------------------------------------------------------------------

    /// After `testSignIn`: Upload tab → "Choose photos" → newest video cell of the PHPicker → Add
    /// → progress bar → Home for 60 s → back → the tile. The picker is an out-of-process remote
    /// view; XCUITest merges it into the app's tree (iOS 16+), with a coordinate tap on the first
    /// cell as the fallback. LL_VIDEO_WAIT (seconds in the background, default 60).
    func testPickVideoAndBackground() throws {
        app.activate()
        let upload = app.webViews.buttons["Upload"].exists ? app.webViews.buttons["Upload"] : app.webViews.links["Upload"]
        if upload.waitForExistence(timeout: 10) { upload.tap() }
        let choose = app.webViews.buttons["Choose photos"]
        XCTAssertTrue(choose.waitForExistence(timeout: 20), "no Choose photos button")
        choose.tap()
        // The PHPicker (iOS 26: grid cells are Images labelled "Video, forty seconds, <date>" /
        // "Photo, <date>", the confirm button is labelled "Done"; older: an "Add" button).
        let grid = app.images.matching(identifier: "PXGGridLayout-Info")
        XCTAssertTrue(grid.firstMatch.waitForExistence(timeout: 15), "the picker grid did not appear")
        dump("video-1-picker")
        let video = app.images.matching(NSPredicate(format: "label BEGINSWITH[c] 'Video'")).firstMatch
        if video.waitForExistence(timeout: 5) {
            video.tap()
        } else {
            // No video label: a Videos filter (older pickers) and the first cell, else a coordinate.
            let videos = app.buttons["Videos"]
            if videos.waitForExistence(timeout: 3) { videos.tap() }
            if grid.firstMatch.waitForExistence(timeout: 5) {
                grid.firstMatch.tap()
            } else {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.17, dy: 0.28)).tap()
            }
        }
        let add = app.buttons["Add"].exists ? app.buttons["Add"] : app.buttons["Done"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), "no Add/Done button in the picker")
        XCTAssertTrue(add.isEnabled, "the picker's Add/Done button stayed disabled (nothing selected)")
        add.tap()
        // Background the app while the ranged parts are in flight; the background session goes on.
        // On the simulator a 55 MiB clip reaches the local stack in ~2 s, so press Home as soon as
        // the item is listed (LL_VIDEO_HOME_DELAY seconds after Add, default 1) rather than waiting
        // for a progress bar that may already be gone. The api log (register/parts/complete
        // timestamps vs. this press) is the evidence of what was in flight.
        let homeDelay = UInt32(env("LL_VIDEO_HOME_DELAY") ?? "1") ?? 1
        _ = element(containing: "clip-").waitForExistence(timeout: 10)
        dump("video-2-picked")
        sleep(homeDelay)
        XCUIDevice.shared.press(.home)
        let wait = UInt32(env("LL_VIDEO_WAIT") ?? "60") ?? 60
        sleep(wait)
        app.activate()
        dump("video-3-resumed")
        let done = element(containing: "uploaded")
        XCTAssertTrue(done.waitForExistence(timeout: 180), "the upload did not finish after backgrounding")
        let tile = app.webViews.buttons["View in timeline"]
        if tile.waitForExistence(timeout: 10) { tile.tap() }
        XCTAssertTrue(app.webViews.images.firstMatch.waitForExistence(timeout: 30), "no tile after the upload")
        dump("video-4-tile")
    }
}
