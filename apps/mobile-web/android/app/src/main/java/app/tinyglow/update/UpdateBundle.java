package app.tinyglow.update;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Live updates core (docs/plans/step-14.md 2.7, task 14.7): pure Java (JCA + org.json), JVM-tested by
 * UpdateBundleTest. Mirrors packages/shared/src/app-update.ts and ios/App/App/LLUpdateBundle.swift:
 * constants, content id, path / base-URL rules, file URLs, signature check, manifest parsing, network
 * policy, the launch/stage/rollback state machine, the bundle directory layout and staging.
 * Nothing here logs: no URL, path, signature or manifest ever reaches a log line.
 */
public final class UpdateBundle {

    private UpdateBundle() {}

    public static final int SCHEMA = 1;
    public static final int MAX_FILES = 2_000;
    public static final long MAX_BUNDLE_BYTES = 64L * 1024 * 1024;
    public static final long CELLULAR_MAX_BYTES = 2L * 1024 * 1024;
    public static final long FREE_SPACE_MARGIN_BYTES = 64L * 1024 * 1024;
    public static final long READY_TIMEOUT_MS = 10_000;
    /** Fallback when the first page load is never observed. */
    public static final long READY_FALLBACK_TIMEOUT_MS = 25_000;
    /** Launches of an unconfirmed bundle (killed before notifyAppReady) before it counts as failed. */
    public static final int MAX_BOOT_ATTEMPTS = 3;
    public static final int MAX_FAILED_REMEMBERED = 20;
    public static final int FILE_TIMEOUT_MS = 20_000;
    public static final int CONCURRENT_DOWNLOADS = 4;
    public static final List<String> EXCLUDE_PREFIXES = Collections.unmodifiableList(
        Arrays.asList("app-update/", ".well-known/", "email-templates/")
    );
    public static final String MANIFEST_PATH = "app-update/manifest.json";
    /** staged marker meaning "the next launch runs the bundled web" (never a valid version). */
    public static final String BUILTIN_MARKER = "builtin";

    public static final class Outcome {
        public static final String STAGED = "staged";
        public static final String UP_TO_DATE = "up_to_date";
        public static final String ALREADY_STAGED = "already_staged";
        public static final String NATIVE_TOO_OLD = "native_too_old";
        public static final String WIFI_REQUIRED = "wifi_required";
        public static final String CONSTRAINED = "constrained";
        public static final String NO_SPACE = "no_space";
        public static final String NETWORK = "network";
        public static final String VERIFY_FAILED = "verify_failed";
        public static final String REJECTED = "rejected";

        private Outcome() {}
    }

    // ---------------------------------------------------------------------------------------------
    // Model

    public static final class FileEntry {
        public final String path;
        public final String sha256;
        public final long size;

        public FileEntry(String path, String sha256, long size) {
            this.path = path;
            this.sha256 = sha256;
            this.size = size;
        }
    }

    public static final class Manifest {
        public final String version;
        public final String webVersion;
        public final int minNativeBuildIos;
        public final int minNativeBuildAndroid;
        public final List<FileEntry> files;
        /** null for the bundled manifest. */
        public final String baseUrl;

        Manifest(String version, String webVersion, int minIos, int minAndroid, List<FileEntry> files, String baseUrl) {
            this.version = version;
            this.webVersion = webVersion;
            this.minNativeBuildIos = minIos;
            this.minNativeBuildAndroid = minAndroid;
            this.files = Collections.unmodifiableList(files);
            this.baseUrl = baseUrl;
        }

        public long totalBytes() {
            long t = 0;
            for (FileEntry f : files) t += f.size;
            return t;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Hashing and content id

    public static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public static String sha256Hex(byte[] data) {
        return hex(sha256().digest(data));
    }

    /** {sha256 hex, size} of a stream's bytes; closes the stream. */
    public static Object[] sha256Hex(InputStream in) throws IOException {
        MessageDigest md = sha256();
        long size = 0;
        try (InputStream s = in) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = s.read(buf)) > 0) {
                md.update(buf, 0, n);
                size += n;
            }
        }
        return new Object[] { hex(md.digest()), size };
    }

    /**
     * sha256 of the UTF-8 of "path\nsha256\n" per file, sorted by path in UTF-16 code-unit order
     * (String.compareTo, same as JS `<`), first 16 hex characters.
     */
    public static String contentId(List<FileEntry> files) {
        List<FileEntry> sorted = new ArrayList<>(files);
        Collections.sort(sorted, (a, b) -> a.path.compareTo(b.path));
        StringBuilder sb = new StringBuilder();
        for (FileEntry f : sorted) sb.append(f.path).append('\n').append(f.sha256).append('\n');
        return sha256Hex(sb.toString().getBytes(StandardCharsets.UTF_8)).substring(0, 16);
    }

    // ---------------------------------------------------------------------------------------------
    // Rules

    private static final Pattern VERSION_RE = Pattern.compile("^[0-9a-f]{16}$");
    private static final Pattern SHA_RE = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern WEB_VERSION_RE = Pattern.compile("^[0-9A-Za-z.+-]{1,32}$");
    private static final Set<String> LOCAL_HTTP_HOSTS = new HashSet<>(Arrays.asList("localhost", "127.0.0.1", "10.0.2.2"));

    public static boolean isVersion(String s) {
        return s != null && VERSION_RE.matcher(s).matches();
    }

    public static boolean isSha256(String s) {
        return s != null && SHA_RE.matcher(s).matches();
    }

    /**
     * Relative, no ".." segment, no NUL (the shared rules), and on the device also no empty or "."
     * segment and no backslash, so a path can only name a file inside the bundle directory.
     */
    public static boolean isSafePath(String p) {
        if (p == null || p.isEmpty() || p.length() > 512 || p.startsWith("/") || p.indexOf('\0') >= 0 || p.indexOf('\\') >= 0) {
            return false;
        }
        for (String seg : p.split("/", -1)) {
            if (seg.isEmpty() || seg.equals(".") || seg.equals("..")) return false;
        }
        return true;
    }

    public static boolean isExcluded(String p) {
        for (String prefix : EXCLUDE_PREFIXES) if (p.startsWith(prefix)) return true;
        return false;
    }

    /** http(s)://host[:port][/path], no credentials, query, fragment or trailing '/'; https unless localhost. */
    public static boolean isValidBaseUrl(String s) {
        if (s == null || s.isEmpty() || s.contains("?") || s.contains("#") || s.endsWith("/")) return false;
        try {
            URI u = new URI(s);
            String scheme = u.getScheme();
            String host = u.getHost();
            if (scheme == null || host == null || host.isEmpty() || u.getRawUserInfo() != null) return false;
            scheme = scheme.toLowerCase(java.util.Locale.ROOT);
            if (scheme.equals("https")) return true;
            return scheme.equals("http") && LOCAL_HTTP_HOSTS.contains(host.toLowerCase(java.util.Locale.ROOT));
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean unreserved(int c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || "-_.!~*'()".indexOf(c) >= 0;
    }

    /** encodeURIComponent per segment, joined with '/' (appUpdateFileUrl). */
    public static String fileUrl(String base, String path) {
        StringBuilder sb = new StringBuilder(base).append('/');
        String[] segs = path.split("/", -1);
        for (int i = 0; i < segs.length; i++) {
            if (i > 0) sb.append('/');
            for (byte b : segs[i].getBytes(StandardCharsets.UTF_8)) {
                int c = b & 0xff;
                if (c < 0x80 && unreserved(c)) sb.append((char) c);
                else sb.append('%').append(String.format("%02X", c));
            }
        }
        return sb.toString();
    }

    // ---------------------------------------------------------------------------------------------
    // Signature (ECDSA P-256 / SHA-256, DER; SPKI DER key; both standard base64)

    /** Strict standard base64 (padded); java.util.Base64 needs API 26, minSdk is 24. */
    public static byte[] base64Decode(String s) {
        if (s == null || s.isEmpty() || s.length() % 4 != 0) return null;
        final String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        ByteArrayOutputStream out = new ByteArrayOutputStream(s.length() / 4 * 3);
        for (int i = 0; i < s.length(); i += 4) {
            int n = 0;
            int chars = 0;
            for (int j = 0; j < 4; j++) {
                char c = s.charAt(i + j);
                if (c == '=') {
                    // Padding only in the last quantum, positions 3-4, and nothing after it.
                    if (i + 4 != s.length() || j < 2 || (j == 2 && s.charAt(i + 3) != '=')) return null;
                    break;
                }
                int d = alphabet.indexOf(c);
                if (d < 0) return null;
                n = (n << 6) | d;
                chars++;
            }
            n <<= 6 * (4 - chars);
            out.write((n >> 16) & 0xff);
            if (chars >= 3) out.write((n >> 8) & 0xff);
            if (chars == 4) out.write(n & 0xff);
        }
        return out.toByteArray();
    }

    public static boolean verifySignature(byte[] message, String signatureBase64, String spkiBase64) {
        try {
            byte[] sig = base64Decode(signatureBase64);
            byte[] spki = base64Decode(spkiBase64);
            if (sig == null || spki == null || sig.length > 72) return false;
            PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(spki));
            Signature v = Signature.getInstance("SHA256withECDSA");
            v.initVerify(key);
            v.update(message);
            return v.verify(sig);
        } catch (Exception e) {
            return false;
        }
    }

    /** keyId selects one trusted key; an unknown id or a bad signature is false. */
    public static boolean verifyEnvelope(String manifestJson, String signature, String keyId, Map<String, String> trusted) {
        String spki = keyId == null ? null : trusted.get(keyId);
        if (spki == null || manifestJson == null) return false;
        return verifySignature(manifestJson.getBytes(StandardCharsets.UTF_8), signature, spki);
    }

    // ---------------------------------------------------------------------------------------------
    // Parsing

    private static Long integer(Object o) {
        if (o instanceof Integer || o instanceof Long) return ((Number) o).longValue();
        return null;
    }

    /**
     * Strict parse (requireBaseUrl: the signed envelope; else the bundled public/app-update/manifest.json).
     * Also checks that version is the content id of files. null = invalid.
     */
    public static Manifest parse(String json, boolean requireBaseUrl) {
        try {
            JSONObject o = new JSONObject(json);
            Long schema = integer(o.opt("schema"));
            Object version = o.opt("version");
            Object webVersion = o.opt("webVersion");
            JSONObject mnb = o.optJSONObject("minNativeBuild");
            Object builtAt = o.opt("builtAt");
            JSONArray rawFiles = o.optJSONArray("files");
            if (schema == null || schema != SCHEMA || !(version instanceof String) || !isVersion((String) version)) return null;
            if (!(webVersion instanceof String) || !WEB_VERSION_RE.matcher((String) webVersion).matches()) return null;
            if (mnb == null || !(builtAt instanceof String) || rawFiles == null) return null;
            Long minIos = integer(mnb.opt("ios"));
            Long minAndroid = integer(mnb.opt("android"));
            if (minIos == null || minIos < 1 || minIos > Integer.MAX_VALUE || minAndroid == null || minAndroid < 1 || minAndroid > Integer.MAX_VALUE) {
                return null;
            }
            if (rawFiles.length() < 1 || rawFiles.length() > MAX_FILES) return null;
            String baseUrl = null;
            if (requireBaseUrl) {
                Object b = o.opt("baseUrl");
                if (!(b instanceof String) || !isValidBaseUrl((String) b)) return null;
                baseUrl = (String) b;
            }
            List<FileEntry> files = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            long total = 0;
            for (int i = 0; i < rawFiles.length(); i++) {
                JSONObject f = rawFiles.optJSONObject(i);
                if (f == null) return null;
                Object path = f.opt("path");
                Object sha = f.opt("sha256");
                Long size = integer(f.opt("size"));
                if (!(path instanceof String) || !isSafePath((String) path) || isExcluded((String) path)) return null;
                if (!(sha instanceof String) || !isSha256((String) sha)) return null;
                if (size == null || size < 0 || size > MAX_BUNDLE_BYTES || !seen.add((String) path)) return null;
                total += size;
                files.add(new FileEntry((String) path, (String) sha, size));
            }
            if (!seen.contains("index.html") || total > MAX_BUNDLE_BYTES || !contentId(files).equals(version)) return null;
            return new Manifest((String) version, (String) webVersion, minIos.intValue(), minAndroid.intValue(), files, baseUrl);
        } catch (JSONException | RuntimeException e) {
            return null;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Network policy (D4)

    public static final class NetworkFacts {
        public boolean online;
        public boolean metered;
        /** Data Saver on a metered network. */
        public boolean dataSaver;
        public boolean powerSave;
        public boolean thermalHot;
    }

    /** null = go ahead. Only consulted when bytes have to be downloaded. */
    public static String networkDecision(long bytes, NetworkFacts n) {
        if (bytes <= 0) return null;
        if (n.dataSaver || n.powerSave || n.thermalHot) return Outcome.CONSTRAINED;
        if (!n.online) return Outcome.NETWORK;
        if (n.metered && bytes > CELLULAR_MAX_BYTES) return Outcome.WIFI_REQUIRED;
        return null;
    }

    public static boolean hasSpace(long available, long needed) {
        return available >= needed + FREE_SPACE_MARGIN_BYTES;
    }

    // ---------------------------------------------------------------------------------------------
    // State (<bundles>/state.json): version ids and counters only; no URL, no timestamp.

    public static final class State {
        /** "<versionName>(<versionCode>)" the state belongs to; another value = new binary. */
        public String binary = "";
        /** OTA version this WebView runs (null = the bundled web). */
        public String current;
        /** Version (or BUILTIN_MARKER) the next launch switches to. */
        public String staged;
        /** Last good version before current (rollback target). */
        public String previous;
        public List<String> good = new ArrayList<>();
        public List<String> failed = new ArrayList<>();
        /** Launches of current without notifyAppReady. */
        public int attempts;

        public State copy() {
            State s = new State();
            s.binary = binary;
            s.current = current;
            s.staged = staged;
            s.previous = previous;
            s.good = new ArrayList<>(good);
            s.failed = new ArrayList<>(failed);
            s.attempts = attempts;
            return s;
        }

        public String toJson() {
            try {
                JSONObject o = new JSONObject();
                o.put("binary", binary);
                o.put("current", current == null ? JSONObject.NULL : current);
                o.put("staged", staged == null ? JSONObject.NULL : staged);
                o.put("previous", previous == null ? JSONObject.NULL : previous);
                o.put("good", new JSONArray(good));
                o.put("failed", new JSONArray(failed));
                o.put("attempts", attempts);
                return o.toString();
            } catch (JSONException e) {
                return "{}";
            }
        }

        public static State fromJson(String json) {
            State s = new State();
            try {
                JSONObject o = new JSONObject(json);
                s.binary = o.optString("binary", "");
                s.current = str(o, "current");
                s.staged = str(o, "staged");
                s.previous = str(o, "previous");
                s.good = list(o.optJSONArray("good"));
                s.failed = list(o.optJSONArray("failed"));
                s.attempts = o.optInt("attempts", 0);
            } catch (JSONException e) {
                return new State();
            }
            return s;
        }

        private static String str(JSONObject o, String k) {
            Object v = o.opt(k);
            return v instanceof String ? (String) v : null;
        }

        private static List<String> list(JSONArray a) {
            List<String> out = new ArrayList<>();
            if (a == null) return out;
            for (int i = 0; i < a.length(); i++) {
                Object v = a.opt(i);
                if (v instanceof String) out.add((String) v);
            }
            return out;
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof State && ((State) other).toJson().equals(toJson());
        }

        @Override
        public int hashCode() {
            return toJson().hashCode();
        }
    }

    public interface Exists {
        boolean test(String version);
    }

    public static final class Launch {
        public boolean resetAll;
        public String active;
        public boolean watchdog;
        public String failedNow;
    }

    public enum Decision {
        DONE,
        STAGE_BUILTIN,
        DOWNLOAD,
    }

    /** Result of decide(): DONE carries an outcome. */
    public static final class Decided {
        public final Decision decision;
        public final String outcome;

        Decided(Decision d, String outcome) {
            this.decision = d;
            this.outcome = outcome;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // State machine (same rules as LLUpdateMachine in Swift)

    public static final class Machine {

        private Machine() {}

        /** Runs once per WebView start, before Capacitor's Bridge reads the persisted path. */
        public static Launch launch(State s, String binary, Exists exists) {
            Launch out = new Launch();
            if (!binary.equals(s.binary)) {
                // New native binary (Capacitor drops the persisted path too): start from the bundled web.
                List<String> failed = s.failed;
                clear(s);
                s.binary = binary;
                s.failed = failed;
                out.resetAll = true;
                return out;
            }
            promoteStaged(s, exists);
            if (s.current != null && !exists.test(s.current)) {
                s.current = fallback(s, exists);
                s.previous = null;
                s.attempts = 0;
            }
            if (s.current != null && !s.good.contains(s.current)) {
                s.attempts += 1;
                if (s.attempts > MAX_BOOT_ATTEMPTS) {
                    out.failedNow = s.current;
                    rollback(s, exists);
                }
            }
            out.active = s.current;
            out.watchdog = s.current != null && !s.good.contains(s.current);
            return out;
        }

        private static void clear(State s) {
            s.binary = "";
            s.current = null;
            s.staged = null;
            s.previous = null;
            s.good = new ArrayList<>();
            s.failed = new ArrayList<>();
            s.attempts = 0;
        }

        private static String fallback(State s, Exists exists) {
            String p = s.previous;
            if (p != null && !p.equals(s.current) && s.good.contains(p) && exists.test(p)) return p;
            return null;
        }

        /** staged -> current (launch and applyNow). Returns whether anything changed. */
        public static boolean promoteStaged(State s, Exists exists) {
            String st = s.staged;
            if (st == null) return false;
            s.staged = null;
            if (st.equals(BUILTIN_MARKER)) {
                if (s.current != null && s.good.contains(s.current)) s.previous = s.current;
                s.current = null;
                s.attempts = 0;
                return true;
            }
            if (!exists.test(st)) return true;
            if (s.current != null && s.good.contains(s.current) && !s.current.equals(st)) s.previous = s.current;
            s.current = st;
            s.attempts = 0;
            return true;
        }

        public static void ready(State s) {
            s.attempts = 0;
            if (s.current != null && !s.good.contains(s.current)) s.good.add(s.current);
            Set<String> keep = keepSet(s);
            s.good.retainAll(keep);
        }

        /** Watchdog expiry or too many unconfirmed launches. Returns the target (null = bundled web). */
        public static String rollback(State s, Exists exists) {
            String cur = s.current;
            if (cur == null) return null;
            if (!s.failed.contains(cur)) s.failed.add(cur);
            while (s.failed.size() > MAX_FAILED_REMEMBERED) s.failed.remove(0);
            s.good.remove(cur);
            if (cur.equals(s.staged)) s.staged = null;
            String target = fallback(s, exists);
            s.current = target;
            s.previous = null;
            s.attempts = 0;
            return target;
        }

        /** Order of 2.7 after signature/parse: native_too_old, rejected, up_to_date, already_staged. */
        public static Decided decide(State s, String version, int minNativeBuild, int nativeBuild, String builtinVersion) {
            if (minNativeBuild > nativeBuild) return new Decided(Decision.DONE, Outcome.NATIVE_TOO_OLD);
            if (s.failed.contains(version)) return new Decided(Decision.DONE, Outcome.REJECTED);
            String running = s.current != null ? s.current : builtinVersion;
            if (version.equals(running)) {
                s.staged = null; // the server went back to what runs now: drop a pending switch
                return new Decided(Decision.DONE, Outcome.UP_TO_DATE);
            }
            if (version.equals(s.staged)) return new Decided(Decision.DONE, Outcome.ALREADY_STAGED);
            if (version.equals(builtinVersion)) {
                if (BUILTIN_MARKER.equals(s.staged)) return new Decided(Decision.DONE, Outcome.ALREADY_STAGED);
                return new Decided(Decision.STAGE_BUILTIN, null);
            }
            return new Decided(Decision.DOWNLOAD, null);
        }

        /** Version the persisted path must point at (null = bundled web). */
        public static String nextLaunchVersion(State s) {
            if (s.staged != null) return s.staged.equals(BUILTIN_MARKER) ? null : s.staged;
            return s.current;
        }

        public static Set<String> keepSet(State s) {
            Set<String> k = new LinkedHashSet<>();
            for (String v : new String[] { s.current, s.previous, s.staged }) {
                if (v != null && !v.equals(BUILTIN_MARKER)) k.add(v);
            }
            return k;
        }

        /** "Reset app files": back to the bundled web; failed is kept so a broken bundle is not re-offered. */
        public static void reset(State s) {
            String binary = s.binary;
            List<String> failed = s.failed;
            clear(s);
            s.binary = binary;
            s.failed = failed;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // File layout: <root>/<version>/ (complete bundles, each with app-update/manifest.json),
    // <root>/tmp-<version>/ (being assembled), <root>/state.json. Android root = filesDir/ll-updates.

    public static final class Store {
        public final File root;

        public Store(File root) {
            this.root = root;
        }

        public File bundleDir(String version) {
            return new File(root, version);
        }

        private File stateFile() {
            return new File(root, "state.json");
        }

        public State load() {
            try {
                return State.fromJson(new String(readAll(new FileInputStream(stateFile())), StandardCharsets.UTF_8));
            } catch (IOException e) {
                return new State();
            }
        }

        public void save(State s) {
            //noinspection ResultOfMethodCallIgnored
            root.mkdirs();
            File tmp = new File(root, "state.json.tmp");
            try (OutputStream out = new FileOutputStream(tmp)) {
                out.write(s.toJson().getBytes(StandardCharsets.UTF_8));
            } catch (IOException e) {
                return;
            }
            //noinspection ResultOfMethodCallIgnored
            tmp.renameTo(stateFile());
        }

        public boolean hasBundle(String version) {
            if (!isVersion(version)) return false;
            File dir = bundleDir(version);
            return new File(dir, "index.html").isFile() && new File(dir, MANIFEST_PATH).isFile();
        }

        /** Deletes version directories outside keep and tmp-* older than tmpMaxAgeMs. */
        public void prune(Set<String> keep, long nowMs, long tmpMaxAgeMs) {
            File[] entries = root.listFiles();
            if (entries == null) return;
            for (File f : entries) {
                String name = f.getName();
                if (isVersion(name)) {
                    if (!keep.contains(name)) deleteRecursively(f);
                } else if (name.startsWith("tmp-")) {
                    if (nowMs - f.lastModified() >= tmpMaxAgeMs) deleteRecursively(f);
                }
            }
        }

        public void prune(Set<String> keep) {
            prune(keep, System.currentTimeMillis(), 86_400_000L);
        }

        public void deleteAllBundles() {
            File[] entries = root.listFiles();
            if (entries == null) return;
            for (File f : entries) if (!f.getName().equals("state.json")) deleteRecursively(f);
        }

        public void deleteBundle(String version) {
            if (isVersion(version)) deleteRecursively(bundleDir(version));
        }
    }

    public static void deleteRecursively(File f) {
        File[] children = f.isDirectory() ? f.listFiles() : null;
        if (children != null) for (File c : children) deleteRecursively(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    public static byte[] readAll(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Staging

    /** A web build plus its app-update/manifest.json (the bundled assets or an OTA bundle dir). */
    public interface Source {
        InputStream open(String path) throws IOException;
    }

    public static final class DirSource implements Source {
        private final File dir;

        public DirSource(File dir) {
            this.dir = dir;
        }

        @Override
        public InputStream open(String path) throws IOException {
            return new FileInputStream(new File(dir, path));
        }
    }

    /** A source with its sha256 -> path index (from its own manifest), or null. */
    public static final class IndexedSource {
        public final Source source;
        public final Map<String, String> bySha;

        IndexedSource(Source source, Map<String, String> bySha) {
            this.source = source;
            this.bySha = bySha;
        }

        public static IndexedSource open(Source source) {
            try {
                Manifest m = parse(new String(readAll(source.open(MANIFEST_PATH)), StandardCharsets.UTF_8), false);
                if (m == null) return null;
                Map<String, String> map = new HashMap<>();
                for (FileEntry f : m.files) if (!map.containsKey(f.sha256)) map.put(f.sha256, f.path);
                return new IndexedSource(source, map);
            } catch (IOException e) {
                return null;
            }
        }
    }

    public interface Fetcher {
        byte[] fetch(String url) throws IOException;
    }

    public static final class StageException extends Exception {
        public final String outcome;

        public StageException(String outcome) {
            super(outcome);
            this.outcome = outcome;
        }
    }

    public static final class Plan {
        public final List<FileEntry> local = new ArrayList<>();
        public final List<Source> localSource = new ArrayList<>();
        public final List<String> localPath = new ArrayList<>();
        public final List<FileEntry> remote = new ArrayList<>();

        public long remoteBytes() {
            long t = 0;
            for (FileEntry f : remote) t += f.size;
            return t;
        }
    }

    /** Files already on the device (same sha256 in a source) are copied; the rest download. */
    public static Plan plan(Manifest m, List<IndexedSource> sources) {
        Plan p = new Plan();
        for (FileEntry f : m.files) {
            boolean found = false;
            for (IndexedSource s : sources) {
                String path = s.bySha.get(f.sha256);
                if (path != null) {
                    p.local.add(f);
                    p.localSource.add(s.source);
                    p.localPath.add(path);
                    found = true;
                    break;
                }
            }
            if (!found) p.remote.add(f);
        }
        return p;
    }

    private static File target(File tmp, String path) throws StageException, IOException {
        File out = new File(tmp, path);
        if (!out.getCanonicalPath().startsWith(tmp.getCanonicalPath() + File.separator)) throw new StageException(Outcome.VERIFY_FAILED);
        File parent = out.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdirs");
        return out;
    }

    private static boolean matches(File f, FileEntry e) {
        try {
            Object[] h = sha256Hex(new FileInputStream(f));
            return e.sha256.equals(h[0]) && ((Long) h[1]) == e.size;
        } catch (IOException ex) {
            return false;
        }
    }

    private static void copy(InputStream in, File dst) throws IOException {
        try (InputStream s = in; OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    /**
     * Builds <root>/tmp-<version>/, verifies every file's sha256 and size, then renames it to
     * <root>/<version>/. Nothing partial is ever left under a version name. Throws StageException
     * with network or verify_failed.
     */
    public static void assemble(Manifest m, byte[] manifestJson, Plan plan, Store store, Fetcher fetcher) throws StageException {
        if (m.baseUrl == null) throw new StageException(Outcome.VERIFY_FAILED);
        File tmp = new File(store.root, "tmp-" + m.version);
        deleteRecursively(tmp);
        ExecutorService pool = null;
        try {
            if (!tmp.mkdirs()) throw new IOException("mkdirs");
            List<FileEntry> remote = new ArrayList<>(plan.remote);
            for (int i = 0; i < plan.local.size(); i++) {
                FileEntry f = plan.local.get(i);
                File dst = target(tmp, f.path);
                try {
                    copy(plan.localSource.get(i).open(plan.localPath.get(i)), dst);
                    if (matches(dst, f)) continue;
                } catch (IOException ignored) {
                    // fall through: download it instead
                }
                //noinspection ResultOfMethodCallIgnored
                dst.delete();
                remote.add(f);
            }
            pool = Executors.newFixedThreadPool(CONCURRENT_DOWNLOADS);
            final AtomicReference<String> failure = new AtomicReference<>();
            List<Future<?>> futures = new ArrayList<>();
            for (final FileEntry f : remote) {
                final File dst = target(tmp, f.path);
                final String url = fileUrl(m.baseUrl, f.path);
                futures.add(
                    pool.submit(() -> {
                        if (failure.get() != null) return;
                        byte[] data;
                        try {
                            data = fetcher.fetch(url);
                        } catch (IOException | RuntimeException e) {
                            failure.compareAndSet(null, Outcome.NETWORK);
                            return;
                        }
                        if (data == null || data.length != f.size || !sha256Hex(data).equals(f.sha256)) {
                            failure.compareAndSet(null, Outcome.VERIFY_FAILED);
                            return;
                        }
                        try (OutputStream out = new FileOutputStream(dst)) {
                            out.write(data);
                        } catch (IOException e) {
                            failure.compareAndSet(null, Outcome.NETWORK);
                        }
                    })
                );
            }
            for (Future<?> fu : futures) {
                try {
                    fu.get();
                } catch (Exception e) {
                    failure.compareAndSet(null, Outcome.NETWORK);
                }
            }
            if (failure.get() != null) throw new StageException(failure.get());
            for (FileEntry f : remote) if (!matches(new File(tmp, f.path), f)) throw new StageException(Outcome.VERIFY_FAILED);
            File mfile = target(tmp, MANIFEST_PATH);
            try (OutputStream out = new FileOutputStream(mfile)) {
                out.write(manifestJson);
            }
            File dest = store.bundleDir(m.version);
            deleteRecursively(dest);
            if (!tmp.renameTo(dest)) throw new IOException("rename");
        } catch (StageException e) {
            deleteRecursively(tmp);
            throw e;
        } catch (IOException | RuntimeException e) {
            deleteRecursively(tmp);
            throw new StageException(Outcome.NETWORK);
        } finally {
            if (pool != null) pool.shutdownNow();
        }
    }
}
