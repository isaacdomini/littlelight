package app.tinyglow.update;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.WebView;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Bridge `TinyglowUpdater` (docs/plans/step-14.md 2.7, task 14.7): the signed OTA web bundle. Same JS
 * contract as iOS (TinyglowUpdater.swift); the rules live in UpdateBundle (JVM-tested).
 *
 *   info()                                    -> { nativeVersion, nativeBuild, builtinVersion, currentVersion,
 *                                                  currentSource, stagedVersion, androidPushConfigured }
 *   stage({ manifestJson, signature, keyId })  -> { outcome, version?, bytes? }
 *   notifyAppReady()                           -> cancels the watchdog, marks the running bundle good
 *   applyNow()                                 -> reloads into the staged bundle (JS checks idle first)
 *   reset()                                    -> back to the bundled web, deletes every OTA bundle
 *
 * Built on Capacitor's own persisted path: SharedPreferences "CapWebViewSettings" / "serverBasePath",
 * read by Bridge.loadWebView() (ignored and cleared on a new binary). load() runs from
 * Bridge.registerAllPlugins(), i.e. before loadWebView(), so the launch decision (promote staged,
 * roll back, new binary) and the preference always agree. Bundles: filesDir/ll-updates/<version>/.
 *
 * Never logs: no URL, path, signature, manifest or file name (outcomes travel to JS only).
 */
@CapacitorPlugin(name = "TinyglowUpdater")
public class TinyglowUpdaterPlugin extends Plugin {

    private static final String PREFS = com.getcapacitor.plugin.WebView.WEBVIEW_PREFS_NAME;
    private static final String PATH_KEY = com.getcapacitor.plugin.WebView.CAP_SERVER_PATH;
    private static final Object LOCK = new Object();
    private static final ExecutorService STAGE = Executors.newSingleThreadExecutor();
    private static final ExecutorService STATE = Executors.newSingleThreadExecutor();

    private final Handler main = new Handler(Looper.getMainLooper());
    private UpdateBundle.Store store;
    private String nativeVersion = "";
    private int nativeBuild;
    private String binary = "";
    private String builtinVersion;

    // Watchdog (main thread only).
    private boolean armed;
    private boolean pendingUntilActive;
    private Runnable timer;

    private interface StateOp<T> {
        T apply(UpdateBundle.State s);
    }

    /** Lock-protected read-modify-write of state.json; keeps Capacitor's persisted path in step. */
    private <T> T withState(StateOp<T> op) {
        synchronized (LOCK) {
            UpdateBundle.State s = store.load();
            UpdateBundle.State before = s.copy();
            T result = op.apply(s);
            if (!s.equals(before)) store.save(s);
            String next = UpdateBundle.Machine.nextLaunchVersion(s);
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
            String value = next == null ? "" : store.bundleDir(next).getAbsolutePath();
            if (!value.equals(prefs.getString(PATH_KEY, ""))) prefs.edit().putString(PATH_KEY, value).apply(); // in-memory at once; Bridge reads the same instance
            return result;
        }
    }

    @Override
    public void load() {
        Context ctx = getContext();
        store = new UpdateBundle.Store(new File(ctx.getFilesDir(), "ll-updates"));
        try {
            PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            nativeVersion = info.versionName != null ? info.versionName : "";
            nativeBuild = (int) PackageInfoCompat.getLongVersionCode(info);
        } catch (Exception ignored) {
            // stays 0: every bundle with minNativeBuild >= 1 is then native_too_old
        }
        binary = nativeVersion + "(" + nativeBuild + ")";
        builtinVersion = readBuiltinVersion();

        UpdateBundle.Launch launch = withState(s -> {
            UpdateBundle.Launch r = UpdateBundle.Machine.launch(s, binary, store::hasBundle);
            if (r.resetAll) {
                store.deleteAllBundles();
            } else {
                if (r.failedNow != null) store.deleteBundle(r.failedNow);
                store.prune(UpdateBundle.Machine.keepSet(s));
            }
            return r;
        });
        if (launch.watchdog) arm(UpdateBundle.READY_FALLBACK_TIMEOUT_MS);
        bridge.addWebViewListener(
            new WebViewListener() {
                @Override
                public void onPageLoaded(WebView webView) {
                    main.post(TinyglowUpdaterPlugin.this::pageFinished);
                }
            }
        );
    }

    private String readBuiltinVersion() {
        try {
            InputStream in = getContext().getAssets().open("public/" + UpdateBundle.MANIFEST_PATH);
            UpdateBundle.Manifest m = UpdateBundle.parse(new String(UpdateBundle.readAll(in), StandardCharsets.UTF_8), false);
            return m == null ? null : m.version;
        } catch (IOException e) {
            return null;
        }
    }

    // ---- watchdog

    private void arm(long ms) {
        main.post(() -> {
            armed = true;
            pendingUntilActive = false;
            schedule(ms);
        });
    }

    private void disarm() {
        armed = false;
        pendingUntilActive = false;
        if (timer != null) main.removeCallbacks(timer);
        timer = null;
    }

    private void pageFinished() {
        if (armed) schedule(UpdateBundle.READY_TIMEOUT_MS);
    }

    private void schedule(long ms) {
        if (timer != null) main.removeCallbacks(timer);
        timer = this::expired;
        main.postDelayed(timer, ms);
    }

    @Override
    protected void handleOnResume() {
        main.post(() -> {
            if (armed && pendingUntilActive) {
                pendingUntilActive = false;
                schedule(UpdateBundle.READY_TIMEOUT_MS);
            }
        });
    }

    private void expired() {
        if (!armed) return;
        // A paused app may not run its JS: wait until it is in the foreground again.
        if (!bridge.getApp().isActive()) {
            pendingUntilActive = true;
            return;
        }
        disarm();
        STATE.execute(() -> {
            final String[] failed = new String[1];
            final String target = withState(s -> {
                failed[0] = s.current;
                return UpdateBundle.Machine.rollback(s, store::hasBundle);
            });
            main.post(() -> {
                serve(target);
                STATE.execute(() -> {
                    if (failed[0] != null) store.deleteBundle(failed[0]);
                });
            });
        });
    }

    /** Main thread. Points the WebView at version (null = bundled web) and reloads. */
    private void serve(String version) {
        if (version != null) {
            bridge.setServerBasePath(store.bundleDir(version).getAbsolutePath());
        } else {
            bridge.setServerAssetPath("public");
        }
    }

    // ---- methods

    @SuppressLint("DiscouragedApi")
    private boolean androidPushConfigured() {
        // The google-services Gradle plugin generates these resources only when google-services.json exists.
        Context ctx = getContext();
        return ctx.getResources().getIdentifier("google_app_id", "string", ctx.getPackageName()) != 0;
    }

    @PluginMethod
    public void info(PluginCall call) {
        STATE.execute(() -> {
            UpdateBundle.State s = withState(st -> st.copy());
            String builtin = builtinVersion != null ? builtinVersion : "unknown";
            JSObject ret = new JSObject();
            ret.put("nativeVersion", nativeVersion);
            ret.put("nativeBuild", nativeBuild);
            ret.put("builtinVersion", builtin);
            ret.put("currentVersion", s.current != null ? s.current : builtin);
            ret.put("currentSource", s.current == null ? "builtin" : "ota");
            Object staged = org.json.JSONObject.NULL;
            if (s.staged != null) staged = UpdateBundle.BUILTIN_MARKER.equals(s.staged) ? builtin : s.staged;
            ret.put("stagedVersion", staged);
            ret.put("androidPushConfigured", androidPushConfigured());
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void stage(PluginCall call) {
        final String manifestJson = call.getString("manifestJson");
        final String signature = call.getString("signature");
        final String keyId = call.getString("keyId");
        if (manifestJson == null || signature == null || keyId == null || manifestJson.length() > 1_048_576) {
            call.reject("bad-args");
            return;
        }
        STAGE.execute(() -> {
            Object[] r = runStage(manifestJson, signature, keyId);
            JSObject ret = new JSObject();
            ret.put("outcome", (String) r[0]);
            if (r[1] != null) ret.put("version", (String) r[1]);
            if (r[2] != null) ret.put("bytes", (long) (Long) r[2]);
            call.resolve(ret);
        });
    }

    /** {outcome, version or null, bytes or null}. UsableSpace: real free space, conservative on purpose. */
    @SuppressLint("UsableSpace")
    private Object[] runStage(String manifestJson, String signature, String keyId) {
        if (!UpdateBundle.verifyEnvelope(manifestJson, signature, keyId, UpdateKeys.trusted())) {
            return new Object[] { UpdateBundle.Outcome.VERIFY_FAILED, null, null };
        }
        final UpdateBundle.Manifest m = UpdateBundle.parse(manifestJson, true);
        if (m == null) return new Object[] { UpdateBundle.Outcome.VERIFY_FAILED, null, null };

        UpdateBundle.Decided d = withState(s ->
            UpdateBundle.Machine.decide(s, m.version, m.minNativeBuildAndroid, nativeBuild, builtinVersion)
        );
        if (d.decision == UpdateBundle.Decision.DONE) {
            boolean zero = d.outcome.equals(UpdateBundle.Outcome.UP_TO_DATE) || d.outcome.equals(UpdateBundle.Outcome.ALREADY_STAGED);
            return new Object[] { d.outcome, m.version, zero ? 0L : null };
        }
        if (d.decision == UpdateBundle.Decision.STAGE_BUILTIN) {
            withState(s -> {
                s.staged = UpdateBundle.BUILTIN_MARKER;
                return null;
            });
            return new Object[] { UpdateBundle.Outcome.STAGED, m.version, 0L };
        }

        // Local sources: the bundled web (assets), then every OTA bundle on disk.
        List<UpdateBundle.IndexedSource> sources = new ArrayList<>();
        final Context ctx = getContext();
        UpdateBundle.IndexedSource builtin = UpdateBundle.IndexedSource.open(path -> ctx.getAssets().open("public/" + path));
        if (builtin != null) sources.add(builtin);
        Set<String> keep = withState(UpdateBundle.Machine::keepSet);
        for (String v : keep) {
            if (!store.hasBundle(v)) continue;
            UpdateBundle.IndexedSource src = UpdateBundle.IndexedSource.open(new UpdateBundle.DirSource(store.bundleDir(v)));
            if (src != null) sources.add(src);
        }
        UpdateBundle.Plan plan = UpdateBundle.plan(m, sources);
        long bytes = plan.remoteBytes();

        String blocked = UpdateBundle.networkDecision(bytes, networkFacts());
        if (blocked != null) return new Object[] { blocked, m.version, bytes };
        //noinspection ResultOfMethodCallIgnored
        store.root.mkdirs();
        if (!UpdateBundle.hasSpace(store.root.getUsableSpace(), m.totalBytes())) {
            return new Object[] { UpdateBundle.Outcome.NO_SPACE, m.version, bytes };
        }
        try {
            UpdateBundle.assemble(m, manifestJson.getBytes(StandardCharsets.UTF_8), plan, store, TinyglowUpdaterPlugin::download);
        } catch (UpdateBundle.StageException e) {
            return new Object[] { e.outcome, m.version, bytes };
        }
        withState(s -> {
            s.staged = m.version;
            store.prune(UpdateBundle.Machine.keepSet(s));
            return null;
        });
        return new Object[] { UpdateBundle.Outcome.STAGED, m.version, bytes };
    }

    private UpdateBundle.NetworkFacts networkFacts() {
        UpdateBundle.NetworkFacts n = new UpdateBundle.NetworkFacts();
        Context ctx = getContext();
        ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
        if (cm != null) {
            Network active = cm.getActiveNetwork();
            NetworkCapabilities caps = active == null ? null : cm.getNetworkCapabilities(active);
            n.online = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            n.metered = cm.isActiveNetworkMetered();
            n.dataSaver = n.metered && cm.getRestrictBackgroundStatus() == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED;
        } else {
            n.metered = true;
        }
        PowerManager pm = ctx.getSystemService(PowerManager.class);
        if (pm != null) {
            n.powerSave = pm.isPowerSaveMode();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                n.thermalHot = pm.getCurrentThermalStatus() >= PowerManager.THERMAL_STATUS_SEVERE;
            }
        }
        return n;
    }

    /** Foreground GET of one bundle file; at most MAX_BUNDLE_BYTES are read. */
    private static byte[] download(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(UpdateBundle.FILE_TIMEOUT_MS);
            c.setReadTimeout(UpdateBundle.FILE_TIMEOUT_MS);
            c.setUseCaches(false);
            c.setRequestProperty("Accept-Encoding", "identity");
            if (c.getResponseCode() != 200) throw new IOException("status");
            try (InputStream in = c.getInputStream()) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[1 << 16];
                long total = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > UpdateBundle.MAX_BUNDLE_BYTES) throw new IOException("too large");
                    out.write(buf, 0, n);
                }
                return out.toByteArray();
            }
        } finally {
            c.disconnect();
        }
    }

    @PluginMethod
    public void notifyAppReady(PluginCall call) {
        main.post(this::disarm);
        STATE.execute(() -> {
            withState(s -> {
                UpdateBundle.Machine.ready(s);
                store.prune(UpdateBundle.Machine.keepSet(s));
                return null;
            });
            call.resolve();
        });
    }

    @PluginMethod
    public void applyNow(PluginCall call) {
        STATE.execute(() -> {
            final String[] target = new String[1];
            final boolean[] watchdog = new boolean[1];
            boolean changed = withState(s -> {
                if (s.staged == null) return false;
                UpdateBundle.Machine.promoteStaged(s, store::hasBundle);
                target[0] = s.current;
                watchdog[0] = s.current != null && !s.good.contains(s.current);
                return true;
            });
            if (!changed) {
                call.resolve();
                return;
            }
            main.post(() -> {
                if (watchdog[0]) {
                    armed = true;
                    pendingUntilActive = false;
                    schedule(UpdateBundle.READY_FALLBACK_TIMEOUT_MS);
                } else {
                    disarm();
                }
                serve(target[0]);
                call.resolve();
            });
        });
    }

    @PluginMethod
    public void reset(PluginCall call) {
        STATE.execute(() -> {
            withState(s -> {
                UpdateBundle.Machine.reset(s);
                return null;
            });
            main.post(() -> {
                disarm();
                serve(null);
                call.resolve();
                STATE.execute(store::deleteAllBundles);
            });
        });
    }
}
