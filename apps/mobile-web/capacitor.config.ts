import type { CapacitorConfig } from "@capacitor/cli";

// Native shell configuration (docs/plans/step-9.md 2.2). The Capacitor CLI transpiles this file;
// it is deliberately outside the web tsconfig.
//
// loggingBehavior "none" is mandatory: Capacitor's debug logging prints plugin call arguments,
// which would put tokens and presigned URLs into logcat and the Xcode console.

const liveReloadUrl = process.env.CAP_LIVE_RELOAD_URL;
const mixedContent = process.env.CAP_DEV_MIXED_CONTENT === "1";

const config: CapacitorConfig = {
  appId: "app.tinyglow",
  appName: "Tinyglow",
  webDir: "dist",
  loggingBehavior: "none",
  appendUserAgent: "Tinyglow/1.0.0",
  server: {
    androidScheme: "https",
    // Dev live reload only. The release scripts refuse to build with this set.
    ...(liveReloadUrl
      ? { url: liveReloadUrl, cleartext: liveReloadUrl.startsWith("http://") }
      : {}),
  },
  android: {
    // Dev only (CAP_DEV_MIXED_CONTENT=1); release builds are HTTPS-only.
    allowMixedContent: mixedContent,
  },
  ios: {
    contentInset: "never",
  },
  plugins: {
    CapacitorHttp: { enabled: false },
    CapacitorCookies: { enabled: false },
    SplashScreen: { launchAutoHide: false },
    Keyboard: { resize: "native" },
    PushNotifications: { presentationOptions: ["alert", "sound"] },
  },
};

export default config;
