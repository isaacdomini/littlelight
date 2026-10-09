// Small native chrome helpers: haptics, status bar, splash, keyboard. All best effort.

export async function hapticSuccess(): Promise<void> {
  try {
    const { Haptics, NotificationType } = await import("@capacitor/haptics");
    await Haptics.notification({ type: NotificationType.Success });
  } catch {
    // no haptics engine
  }
}

export async function hapticTap(): Promise<void> {
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // no haptics engine
  }
}

/** Matches the status bar text color to the current color scheme. */
export async function syncStatusBar(): Promise<void> {
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
  } catch {
    // unsupported
  }
}

export async function hideSplash(): Promise<void> {
  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  } catch {
    // already hidden
  }
}
