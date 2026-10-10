import UIKit
import Capacitor
import BackgroundTasks

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Before the scene (and so the WebView and its session restore) exists.
        FreshInstall.wipeKeychainIfNeeded(application)
        excludeFromBackup()
        // Must be registered before launch finishes; the handler only forwards to the plugin.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: LLPhotoSync.taskIdentifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            LLPhotoSync.shared.handle(refresh)
        }
        return true
    }

    // Tokens live in the Keychain (this-device-only). The WebView storage and the Cache-API photo
    // cache must not travel to iCloud / device backups either (PRD: privacy and child safety).
    // Nothing here logs URLs, paths or tokens.
    private func excludeFromBackup() {
        let fm = FileManager.default
        guard let library = fm.urls(for: .libraryDirectory, in: .userDomainMask).first,
              let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
        let webKit = library.appendingPathComponent("WebKit", isDirectory: true)
        try? fm.createDirectory(at: webKit, withIntermediateDirectories: true)
        var targets: [URL] = [webKit]
        // Sync ledger (PHAsset identifiers): never backed up, never leaves the device.
        if let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let ledger = support.appendingPathComponent("ll-sync", isDirectory: true)
            try? fm.createDirectory(at: ledger, withIntermediateDirectories: true)
            targets.append(ledger)
        }
        for name in ["ll-uploads", "ll-share", "ll-sync-export"] {
            let dir = caches.appendingPathComponent(name, isDirectory: true)
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            targets.append(dir)
        }
        if let entries = try? fm.contentsOfDirectory(at: caches, includingPropertiesForKeys: nil) {
            targets.append(contentsOf: entries.filter { $0.lastPathComponent.hasPrefix("ll-") })
        }
        for var url in targets where fm.fileExists(atPath: url.path) {
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
        }
    }

    // Push token forwarding to @capacitor/push-notifications.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    // Background uploads: the system relaunches the app to deliver URLSession events.
    func application(_ application: UIApplication,
                     handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard let session = LLUploadSession.forIdentifier(identifier) else { completionHandler(); return }
        session.handleBackgroundEvents(completion: completionHandler)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

/// Keychain items outlive an uninstall; UserDefaults do not. On the first launch after an install
/// (no flag in UserDefaults) every Keychain item of the app is deleted, so a reinstall starts signed
/// out. Runs from `didFinishLaunching`, before the WebView reads the session.
///
/// Only with protected data available: a prewarmed launch before the first unlock reads
/// UserDefaults as empty and would wipe a valid session. (The session item is
/// `afterFirstUnlockThisDeviceOnly`, so the WebView cannot read it then either.) In that case the
/// check runs once protected data becomes available.
enum FreshInstall {
    private static let flagKey = "ll.installed.v1"
    private static var observer: NSObjectProtocol?

    static func wipeKeychainIfNeeded(_ application: UIApplication) {
        guard application.isProtectedDataAvailable else {
            guard observer == nil else { return }
            observer = NotificationCenter.default.addObserver(
                forName: UIApplication.protectedDataDidBecomeAvailableNotification,
                object: nil, queue: .main
            ) { _ in
                if let o = observer { NotificationCenter.default.removeObserver(o) }
                observer = nil
                run()
            }
            return
        }
        run()
    }

    private static func run() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: flagKey) else { return }
        for secClass in [kSecClassGenericPassword, kSecClassInternetPassword, kSecClassKey] {
            let query: [String: Any] = [
                kSecClass as String: secClass,
                kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            ]
            _ = SecItemDelete(query as CFDictionary)
        }
        defaults.set(true, forKey: flagKey)
    }
}
