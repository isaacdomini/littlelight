package app.tinyglow.update;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * JVM unit test of the live-update core (docs/plans/step-14.md 2.7, task 14.7): content id vectors
 * (shared JSDoc), path / base-URL rules, file URLs, signature verification with the dev key (tamper,
 * key selection), manifest parsing, minNativeBuild, network policy, the launch/stage/rollback state
 * machine, staging (local reuse, download, tampered file, network failure) and pruning. Vectors:
 * src/test/resources/app/tinyglow/update/vectors.fixture.json and, when present,
 * e2e/ota/vectors.json (system property tinyglow.otaVectors, set in app/build.gradle).
 * Run: JAVA_HOME=<jdk 21> ./gradlew testDebugUnitTest --tests 'app.tinyglow.update.*'
 */
public class UpdateBundleTest {

    private static final String E = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    private static final String A = "aaaaaaaaaaaaaaaa";
    private static final String B = "bbbbbbbbbbbbbbbb";
    private static final String C = "cccccccccccccccc";
    private static final String BUILTIN = "1111111111111111";
    private static final UpdateBundle.Exists ALL = v -> true;
    private static final UpdateBundle.Exists NONE = v -> false;

    private File tmp;

    @Before
    public void setUp() throws IOException {
        tmp = Files.createTempDirectory("ll-update-test").toFile();
    }

    @After
    public void tearDown() {
        UpdateBundle.deleteRecursively(tmp);
    }

    private static UpdateBundle.FileEntry f(String p, String sha) {
        return new UpdateBundle.FileEntry(p, sha, 0);
    }

    private static String rep(char c, int n) {
        char[] a = new char[n];
        Arrays.fill(a, c);
        return new String(a);
    }

    // ---- vectors

    private static final class Vectors {
        String name;
        String keyId;
        String spki;
        String manifestJson;
        String signature;
        String expectedVersion;
        Map<String, byte[]> files = new HashMap<>();
        String tamperedJson;
        String tamperedSig;
        String tamperedFilePath;
        byte[] tamperedFileContent;
    }

    private static Vectors parseVectors(String name, String text) throws Exception {
        JSONObject o = new JSONObject(text);
        Vectors v = new Vectors();
        v.name = name;
        v.keyId = o.optString("keyId", "dev");
        v.spki = o.optString("spkiBase64", null);
        v.manifestJson = o.getString("manifestJson");
        v.signature = o.getString("signature");
        v.expectedVersion = o.optString("expectedVersion", null);
        JSONObject files = o.optJSONObject("files");
        if (files != null) {
            for (Iterator<String> it = files.keys(); it.hasNext(); ) {
                String k = it.next();
                v.files.put(k, Base64.getDecoder().decode(files.getString(k)));
            }
        }
        JSONObject t = o.optJSONObject("tampered");
        if (t != null) {
            v.tamperedJson = t.getString("manifestJson");
            v.tamperedSig = t.optString("signature", v.signature);
        }
        JSONObject tf = o.optJSONObject("tamperedFile");
        if (tf != null) {
            v.tamperedFilePath = tf.getString("path");
            v.tamperedFileContent = Base64.getDecoder().decode(tf.getString("contentBase64"));
        }
        return v;
    }

    private static List<Vectors> vectors() throws Exception {
        List<Vectors> out = new ArrayList<>();
        try (InputStream in = UpdateBundleTest.class.getResourceAsStream("/app/tinyglow/update/vectors.fixture.json")) {
            assertNotNull("fixture vectors on the test classpath", in);
            out.add(parseVectors("fixture", new String(UpdateBundle.readAll(in), StandardCharsets.UTF_8)));
        }
        String e2e = System.getProperty("tinyglow.otaVectors");
        if (e2e != null && new File(e2e).isFile()) {
            out.add(parseVectors("e2e", new String(UpdateBundle.readAll(new FileInputStream(e2e)), StandardCharsets.UTF_8)));
        }
        return out;
    }

    // ---- content id, rules, URLs

    @Test
    public void contentIdMatchesSharedVectors() {
        assertEquals("da529e6871940b56", UpdateBundle.contentId(Collections.singletonList(f("index.html", E))));
        List<UpdateBundle.FileEntry> two = Arrays.asList(
            f("index.html", "b633a587c652d02386c4f16f8c6f6aab7352d97f16367c3c40576214372dd628"),
            f("assets/app-1.js", "0a286891c11c056e1ab5bfc25bf5d6b2f5b06d38eac10944f678fd8a2e70c393")
        );
        assertEquals("2f80d966699add55", UpdateBundle.contentId(two));
        List<UpdateBundle.FileEntry> rev = new ArrayList<>(two);
        Collections.reverse(rev);
        assertEquals("2f80d966699add55", UpdateBundle.contentId(rev));
        assertEquals(
            "0d576c52526db35a",
            UpdateBundle.contentId(Arrays.asList(f("index.html", rep('0', 64)), f("Z.txt", rep('1', 64)), f("a.txt", rep('2', 64))))
        );
        assertEquals(E, UpdateBundle.sha256Hex(new byte[0]));
    }

    @Test
    public void pathRules() {
        for (String p : new String[] { "index.html", "assets/app-1.js", "a b/c+d.js", "x/.hidden", "é/ü.txt" }) {
            assertTrue(p, UpdateBundle.isSafePath(p));
        }
        for (String p : new String[] { "", "/index.html", "../x", "a/../b", "a/..", "..", "a\0b", "a//b", "./a", "a/./b", "a\\b", "a/", rep('a', 513) }) {
            assertFalse(p, UpdateBundle.isSafePath(p));
        }
        assertTrue(UpdateBundle.isExcluded("app-update/manifest.json"));
        assertTrue(UpdateBundle.isExcluded(".well-known/assetlinks.json"));
        assertTrue(UpdateBundle.isExcluded("email-templates/x.html"));
        assertFalse(UpdateBundle.isExcluded("assets/app-update/x.js"));
    }

    @Test
    public void baseUrlAndFileUrls() {
        for (String u : new String[] { "https://tinyglow.app", "https://tinyglow.app/web", "http://localhost:18090", "http://10.0.2.2:18090", "http://127.0.0.1" }) {
            assertTrue(u, UpdateBundle.isValidBaseUrl(u));
        }
        for (String u : new String[] { "http://tinyglow.app", "https://tinyglow.app/", "https://tinyglow.app?x=1", "https://tinyglow.app#f", "https://u:p@tinyglow.app", "ftp://tinyglow.app", "tinyglow.app", "" }) {
            assertFalse(u, UpdateBundle.isValidBaseUrl(u));
        }
        assertEquals("https://tinyglow.app/assets/app-1.js", UpdateBundle.fileUrl("https://tinyglow.app", "assets/app-1.js"));
        assertEquals("https://h.test/web/assets/a%20b%2Bc.js", UpdateBundle.fileUrl("https://h.test/web", "assets/a b+c.js"));
        assertEquals("https://h.test/x/(a)!~*'-_.%C3%A9", UpdateBundle.fileUrl("https://h.test", "x/(a)!~*'-_.é"));
    }

    @Test
    public void base64DecoderIsStrict() {
        for (int n = 0; n < 70; n++) {
            byte[] d = new byte[n];
            for (int i = 0; i < n; i++) d[i] = (byte) (i * 37 + 11);
            if (n == 0) continue;
            assertArrayEquals("len " + n, d, UpdateBundle.base64Decode(Base64.getEncoder().encodeToString(d)));
        }
        assertNull(UpdateBundle.base64Decode("AQ"));
        assertNull(UpdateBundle.base64Decode("A==="));
        assertNull(UpdateBundle.base64Decode("-_-_"));
        assertNull(UpdateBundle.base64Decode("AQ==AQ=="));
        assertNull(UpdateBundle.base64Decode("A=Q="));
    }

    @Test
    public void networkPolicy() {
        UpdateBundle.NetworkFacts wifi = new UpdateBundle.NetworkFacts();
        wifi.online = true;
        assertNull(UpdateBundle.networkDecision(60L << 20, wifi));
        UpdateBundle.NetworkFacts cell = new UpdateBundle.NetworkFacts();
        cell.online = true;
        cell.metered = true;
        assertNull(UpdateBundle.networkDecision(2L << 20, cell));
        assertEquals("wifi_required", UpdateBundle.networkDecision((2L << 20) + 1, cell));
        UpdateBundle.NetworkFacts saver = new UpdateBundle.NetworkFacts();
        saver.online = true;
        saver.dataSaver = true;
        assertEquals("constrained", UpdateBundle.networkDecision(1, saver));
        UpdateBundle.NetworkFacts power = new UpdateBundle.NetworkFacts();
        power.online = true;
        power.powerSave = true;
        assertEquals("constrained", UpdateBundle.networkDecision(1, power));
        UpdateBundle.NetworkFacts hot = new UpdateBundle.NetworkFacts();
        hot.online = true;
        hot.thermalHot = true;
        assertEquals("constrained", UpdateBundle.networkDecision(1, hot));
        UpdateBundle.NetworkFacts offline = new UpdateBundle.NetworkFacts();
        assertEquals("network", UpdateBundle.networkDecision(1, offline));
        assertNull("nothing to download needs no network", UpdateBundle.networkDecision(0, offline));
        assertTrue(UpdateBundle.hasSpace((64L << 20) + 10, 10));
        assertFalse(UpdateBundle.hasSpace((64L << 20) + 9, 10));
    }

    // ---- parsing

    private static String manifest(JSONArray files, String version, Object schema, String baseUrl, Object minIos) throws Exception {
        List<UpdateBundle.FileEntry> lf = new ArrayList<>();
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.getJSONObject(i);
            lf.add(f(f.optString("path"), f.optString("sha256")));
        }
        JSONObject o = new JSONObject();
        o.put("schema", schema);
        o.put("version", version != null ? version : UpdateBundle.contentId(lf));
        o.put("webVersion", "1.0.0");
        o.put("minNativeBuild", new JSONObject().put("ios", 1).put("android", minIos));
        o.put("builtAt", "2026-10-13T00:00:00.000Z");
        o.put("files", files);
        if (baseUrl != null) o.put("baseUrl", baseUrl);
        return o.toString();
    }

    private static JSONObject file(String path, String sha, Object size) throws Exception {
        return new JSONObject().put("path", path).put("sha256", sha).put("size", size);
    }

    private static JSONArray goodFiles() throws Exception {
        return new JSONArray().put(file("index.html", E, 0)).put(file("assets/a.js", rep('a', 64), 10));
    }

    private static String good(JSONArray extra) throws Exception {
        JSONArray a = goodFiles();
        if (extra != null) for (int i = 0; i < extra.length(); i++) a.put(extra.get(i));
        return manifest(a, null, 1, "https://tinyglow.app", 1);
    }

    @Test
    public void parseAcceptsAndRefuses() throws Exception {
        UpdateBundle.Manifest m = UpdateBundle.parse(good(null), true);
        assertNotNull(m);
        assertEquals(10, m.totalBytes());
        assertNotNull("builtin needs no baseUrl", UpdateBundle.parse(manifest(goodFiles(), null, 1, null, 1), false));
        assertNull("signed needs baseUrl", UpdateBundle.parse(manifest(goodFiles(), null, 1, null, 1), true));
        assertNull("http baseUrl", UpdateBundle.parse(manifest(goodFiles(), null, 1, "http://tinyglow.app", 1), true));
        assertNull("version != content id", UpdateBundle.parse(manifest(goodFiles(), "0123456789abcdef", 1, "https://tinyglow.app", 1), true));
        assertNull("schema 2", UpdateBundle.parse(manifest(goodFiles(), null, 2, "https://tinyglow.app", 1), true));
        assertNull("bool schema", UpdateBundle.parse(manifest(goodFiles(), null, true, "https://tinyglow.app", 1), true));
        assertNull("min 0", UpdateBundle.parse(manifest(goodFiles(), null, 1, "https://tinyglow.app", 0), true));
        assertNull("min 1.5", UpdateBundle.parse(manifest(goodFiles(), null, 1, "https://tinyglow.app", 1.5), true));
        assertNull("no index.html", UpdateBundle.parse(manifest(new JSONArray().put(file("a.html", E, 0)), null, 1, "https://tinyglow.app", 1), true));
        assertNull("duplicate", UpdateBundle.parse(good(new JSONArray().put(file("assets/a.js", E, 0))), true));
        assertNull("excluded", UpdateBundle.parse(good(new JSONArray().put(file(".well-known/assetlinks.json", E, 0))), true));
        assertNull("manifest listed", UpdateBundle.parse(good(new JSONArray().put(file("app-update/manifest.json", E, 0))), true));
        assertNull("..", UpdateBundle.parse(good(new JSONArray().put(file("assets/../../etc", E, 0))), true));
        assertNull("absolute", UpdateBundle.parse(good(new JSONArray().put(file("/etc/passwd", E, 0))), true));
        assertNull("NUL", UpdateBundle.parse(good(new JSONArray().put(file("a\0.js", E, 0))), true));
        assertNull("uppercase sha", UpdateBundle.parse(good(new JSONArray().put(file("b.js", E.toUpperCase(), 0))), true));
        assertNull("negative size", UpdateBundle.parse(good(new JSONArray().put(file("b.js", E, -1))), true));
        assertNull("bool size", UpdateBundle.parse(good(new JSONArray().put(file("b.js", E, true))), true));
        assertNull("file > 64 MiB", UpdateBundle.parse(good(new JSONArray().put(file("b.js", E, (64L << 20) + 1))), true));
        assertNull("total > 64 MiB", UpdateBundle.parse(good(new JSONArray().put(file("b.js", E, 64L << 20))), true));
        JSONArray many = new JSONArray().put(file("index.html", E, 0));
        for (int i = 0; i < 1999; i++) many.put(file("f" + i, E, 0));
        assertNotNull("2000 files", UpdateBundle.parse(manifest(many, null, 1, "https://tinyglow.app", 1), true));
        many.put(file("f-extra", E, 0));
        assertNull("2001 files", UpdateBundle.parse(manifest(many, null, 1, "https://tinyglow.app", 1), true));
        assertNull("not JSON", UpdateBundle.parse("{", false));
    }

    // ---- signature

    @Test
    public void debugBuildTrustsProdAndDevKeys() {
        Map<String, String> keys = UpdateKeys.trusted();
        assertEquals(new HashSet<>(Arrays.asList("prod-2026-10", "dev")), keys.keySet());
    }

    @Test
    public void signatureVectors() throws Exception {
        Map<String, String> trusted = UpdateKeys.trusted();
        for (Vectors v : vectors()) {
            if (v.spki != null) assertEquals(v.name, trusted.get("dev"), v.spki);
            assertTrue(v.name + " verifies", UpdateBundle.verifyEnvelope(v.manifestJson, v.signature, v.keyId, trusted));
            assertFalse(v.name + " prod keyId", UpdateBundle.verifyEnvelope(v.manifestJson, v.signature, "prod-2026-10", trusted));
            assertFalse(v.name + " unknown keyId", UpdateBundle.verifyEnvelope(v.manifestJson, v.signature, "nope", trusted));
            Map<String, String> releaseKeys = new HashMap<>(trusted);
            releaseKeys.remove("dev");
            assertFalse(v.name + " release keys refuse dev", UpdateBundle.verifyEnvelope(v.manifestJson, v.signature, v.keyId, releaseKeys));
            if (v.tamperedJson != null) {
                assertFalse(v.name + " tampered", UpdateBundle.verifyEnvelope(v.tamperedJson, v.tamperedSig, v.keyId, trusted));
            }
            byte[] msg = v.manifestJson.getBytes(StandardCharsets.UTF_8);
            msg[msg.length / 2] ^= 1;
            assertFalse(v.name + " flipped byte", UpdateBundle.verifySignature(msg, v.signature, trusted.get("dev")));
            byte[] sig = Base64.getDecoder().decode(v.signature);
            sig[sig.length - 1] ^= 1;
            assertFalse(
                v.name + " flipped sig byte",
                UpdateBundle.verifySignature(v.manifestJson.getBytes(StandardCharsets.UTF_8), Base64.getEncoder().encodeToString(sig), trusted.get("dev"))
            );
            assertFalse(v.name + " garbage sig", UpdateBundle.verifyEnvelope(v.manifestJson, "AAAA", v.keyId, trusted));
            UpdateBundle.Manifest m = UpdateBundle.parse(v.manifestJson, true);
            assertNotNull(v.name + " parses", m);
            if (v.expectedVersion != null) assertEquals(v.name, v.expectedVersion, m.version);
        }
    }

    // ---- state machine

    @Test
    public void stateMachineHappyPathRollbackAndRejection() {
        UpdateBundle.State s = new UpdateBundle.State();
        UpdateBundle.Launch l = UpdateBundle.Machine.launch(s, "1.0.0(1)", ALL);
        assertTrue(l.resetAll);
        assertNull(l.active);
        assertEquals("native_too_old", UpdateBundle.Machine.decide(s, B, 2, 1, BUILTIN).outcome);
        assertEquals("up_to_date", UpdateBundle.Machine.decide(s, BUILTIN, 1, 1, BUILTIN).outcome);
        assertEquals(UpdateBundle.Decision.DOWNLOAD, UpdateBundle.Machine.decide(s, B, 1, 1, BUILTIN).decision);
        s.staged = B;
        assertEquals(B, UpdateBundle.Machine.nextLaunchVersion(s));
        assertEquals("already_staged", UpdateBundle.Machine.decide(s, B, 1, 1, BUILTIN).outcome);
        l = UpdateBundle.Machine.launch(s, "1.0.0(1)", ALL);
        assertEquals(B, l.active);
        assertTrue(l.watchdog);
        assertEquals(1, s.attempts);
        UpdateBundle.Machine.ready(s);
        assertEquals(Collections.singletonList(B), s.good);
        l = UpdateBundle.Machine.launch(s, "1.0.0(1)", ALL);
        assertFalse(l.watchdog);
        s.staged = C;
        l = UpdateBundle.Machine.launch(s, "1.0.0(1)", ALL);
        assertEquals(C, l.active);
        assertEquals(B, s.previous);
        assertEquals(new HashSet<>(Arrays.asList(B, C)), UpdateBundle.Machine.keepSet(s));
        assertEquals(B, UpdateBundle.Machine.rollback(s, ALL));
        assertEquals(B, s.current);
        assertEquals(Collections.singletonList(C), s.failed);
        assertEquals("rejected", UpdateBundle.Machine.decide(s, C, 1, 1, BUILTIN).outcome);
        l = UpdateBundle.Machine.launch(s, "1.0.0(1)", ALL);
        assertEquals(B, l.active);
        assertFalse(l.watchdog);
        s.staged = A;
        assertEquals("up_to_date", UpdateBundle.Machine.decide(s, B, 1, 1, BUILTIN).outcome);
        assertNull("pending switch dropped", s.staged);
        assertEquals(UpdateBundle.Decision.STAGE_BUILTIN, UpdateBundle.Machine.decide(s, BUILTIN, 1, 1, BUILTIN).decision);
        s.staged = UpdateBundle.BUILTIN_MARKER;
        assertNull(UpdateBundle.Machine.nextLaunchVersion(s));
        assertEquals("already_staged", UpdateBundle.Machine.decide(s, BUILTIN, 1, 1, BUILTIN).outcome);
        l = UpdateBundle.Machine.launch(s, "1.0.0(1)", ALL);
        assertNull(l.active);
        assertEquals(B, s.previous);
    }

    @Test
    public void stateMachineEdgeCases() {
        UpdateBundle.State k = new UpdateBundle.State();
        k.binary = "x";
        k.staged = A;
        for (int i = 1; i <= 3; i++) {
            UpdateBundle.Launch l = UpdateBundle.Machine.launch(k, "x", ALL);
            assertEquals(A, l.active);
            assertTrue(l.watchdog);
        }
        UpdateBundle.Launch l = UpdateBundle.Machine.launch(k, "x", ALL);
        assertEquals(A, l.failedNow);
        assertNull(l.active);

        UpdateBundle.State m1 = new UpdateBundle.State();
        m1.binary = "x";
        m1.current = B;
        m1.good.add(B);
        assertNull(UpdateBundle.Machine.launch(m1, "x", NONE).active);

        UpdateBundle.State m2 = new UpdateBundle.State();
        m2.binary = "x";
        m2.current = B;
        m2.staged = C;
        m2.good.add(B);
        assertEquals(B, UpdateBundle.Machine.launch(m2, "x", v -> v.equals(B)).active);
        assertNull(m2.staged);

        UpdateBundle.State nb = new UpdateBundle.State();
        nb.binary = "1.0.0(1)";
        nb.current = B;
        nb.good.add(B);
        nb.failed.add(C);
        l = UpdateBundle.Machine.launch(nb, "1.0.1(2)", ALL);
        assertTrue(l.resetAll);
        assertNull(nb.current);
        assertTrue(nb.good.isEmpty());
        assertEquals(Collections.singletonList(C), nb.failed);

        UpdateBundle.State r = new UpdateBundle.State();
        r.binary = "x";
        r.current = B;
        r.previous = A;
        r.staged = C;
        r.good.addAll(Arrays.asList(A, B));
        r.failed.add(C);
        UpdateBundle.Machine.reset(r);
        assertNull(r.current);
        assertNull(r.previous);
        assertNull(r.staged);
        assertTrue(r.good.isEmpty());
        assertEquals(Collections.singletonList(C), r.failed);
        assertEquals("x", r.binary);

        UpdateBundle.State fl = new UpdateBundle.State();
        for (int i = 0; i < 25; i++) {
            fl.current = String.format("%016x", i);
            UpdateBundle.Machine.rollback(fl, ALL);
        }
        assertEquals(20, fl.failed.size());
        assertEquals(String.format("%016x", 5), fl.failed.get(0));

        UpdateBundle.Store store = new UpdateBundle.Store(new File(tmp, "bundles"));
        store.save(r);
        assertEquals(r, store.load());
        UpdateBundle.State back = UpdateBundle.State.fromJson(r.toJson());
        assertEquals(r.toJson(), back.toJson());
        assertFalse(r.toJson().contains("http"));
    }

    // ---- staging

    private static void write(File f, byte[] data) throws IOException {
        //noinspection ResultOfMethodCallIgnored
        f.getParentFile().mkdirs();
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(data);
        }
    }

    @Test
    public void stagingReusesLocalFilesVerifiesAndPrunes() throws Exception {
        final Vectors v = vectors().get(0);
        final UpdateBundle.Manifest m = UpdateBundle.parse(v.manifestJson, true);
        assertNotNull(m);
        final byte[] mj = v.manifestJson.getBytes(StandardCharsets.UTF_8);
        UpdateBundle.Store store = new UpdateBundle.Store(new File(tmp, "bundles"));
        //noinspection ResultOfMethodCallIgnored
        store.root.mkdirs();
        final List<String> fetched = Collections.synchronizedList(new ArrayList<>());
        final Map<String, byte[]> byUrl = new HashMap<>();
        for (UpdateBundle.FileEntry fe : m.files) byUrl.put(UpdateBundle.fileUrl(m.baseUrl, fe.path), v.files.get(fe.path));

        // builtin: index.html differs, assets/app-1.js identical
        final String shared = "assets/app-1.js";
        File builtin = new File(tmp, "public");
        byte[] oldIndex = "<html>A</html>".getBytes(StandardCharsets.UTF_8);
        write(new File(builtin, "index.html"), oldIndex);
        write(new File(builtin, shared), v.files.get(shared));
        List<UpdateBundle.FileEntry> bfiles = Arrays.asList(
            new UpdateBundle.FileEntry("index.html", UpdateBundle.sha256Hex(oldIndex), oldIndex.length),
            new UpdateBundle.FileEntry(shared, UpdateBundle.sha256Hex(v.files.get(shared)), v.files.get(shared).length)
        );
        JSONArray ba = new JSONArray();
        for (UpdateBundle.FileEntry fe : bfiles) ba.put(file(fe.path, fe.sha256, fe.size));
        JSONObject bm = new JSONObject()
            .put("schema", 1)
            .put("version", UpdateBundle.contentId(bfiles))
            .put("webVersion", "1.0.0")
            .put("minNativeBuild", new JSONObject().put("ios", 1).put("android", 1))
            .put("builtAt", "2026-10-13T00:00:00.000Z")
            .put("files", ba);
        write(new File(builtin, UpdateBundle.MANIFEST_PATH), bm.toString().getBytes(StandardCharsets.UTF_8));
        // Asset-style source (streams), as the plugin opens the APK's assets.
        final File builtinDir = builtin;
        UpdateBundle.IndexedSource src = UpdateBundle.IndexedSource.open(path -> new FileInputStream(new File(builtinDir, path)));
        assertNotNull(src);
        UpdateBundle.Plan plan = UpdateBundle.plan(m, Collections.singletonList(src));
        assertEquals(1, plan.local.size());
        assertEquals(m.files.size() - 1, plan.remote.size());

        // tampered file -> verify_failed, nothing staged
        if (v.tamperedFilePath != null) {
            final String turl = UpdateBundle.fileUrl(m.baseUrl, v.tamperedFilePath);
            try {
                UpdateBundle.assemble(m, mj, UpdateBundle.plan(m, new ArrayList<>()), store, url ->
                    url.equals(turl) ? v.tamperedFileContent : byUrl.get(url)
                );
                fail("tampered file staged");
            } catch (UpdateBundle.StageException e) {
                assertEquals("verify_failed", e.outcome);
            }
            assertFalse(store.hasBundle(m.version));
            assertFalse(new File(store.root, "tmp-" + m.version).exists());
        }
        // network failure
        try {
            UpdateBundle.assemble(m, mj, plan, store, url -> {
                throw new IOException("offline");
            });
            fail("staged without network");
        } catch (UpdateBundle.StageException e) {
            assertEquals("network", e.outcome);
        }
        assertFalse(store.hasBundle(m.version));
        assertFalse(new File(store.root, "tmp-" + m.version).exists());
        // success
        UpdateBundle.assemble(m, mj, plan, store, url -> {
            fetched.add(url);
            byte[] d = byUrl.get(url);
            if (d == null) throw new IOException("404");
            return d;
        });
        assertTrue(store.hasBundle(m.version));
        assertEquals(plan.remote.size(), fetched.size());
        for (String u : fetched) {
            assertFalse(u.endsWith(shared));
            assertFalse(u.contains(" "));
        }
        File dir = store.bundleDir(m.version);
        for (UpdateBundle.FileEntry fe : m.files) {
            Object[] h = UpdateBundle.sha256Hex(new FileInputStream(new File(dir, fe.path)));
            assertEquals(fe.sha256, h[0]);
            assertEquals(fe.size, (long) (Long) h[1]);
        }
        assertArrayEquals(mj, UpdateBundle.readAll(new FileInputStream(new File(dir, UpdateBundle.MANIFEST_PATH))));
        assertNotNull("staged bundle is a source", UpdateBundle.IndexedSource.open(new UpdateBundle.DirSource(dir)));

        // a changed local copy is downloaded instead
        byte[] bad = Arrays.copyOf(v.files.get(shared), v.files.get(shared).length + 1);
        bad[bad.length - 1] = ' ';
        write(new File(builtin, shared), bad);
        store.deleteBundle(m.version);
        fetched.clear();
        UpdateBundle.assemble(m, mj, plan, store, url -> {
            fetched.add(url);
            return byUrl.get(url);
        });
        assertTrue(store.hasBundle(m.version));
        boolean refetched = false;
        for (String u : fetched) refetched |= u.endsWith("app-1.js");
        assertTrue(refetched);

        // prune: keep set + fresh tmp + state.json
        for (String name : new String[] { A, B, C }) //noinspection ResultOfMethodCallIgnored
            store.bundleDir(name).mkdirs();
        File oldTmp = new File(store.root, "tmp-" + A);
        File newTmp = new File(store.root, "tmp-" + B);
        //noinspection ResultOfMethodCallIgnored
        oldTmp.mkdirs();
        //noinspection ResultOfMethodCallIgnored
        newTmp.mkdirs();
        long now = System.currentTimeMillis();
        //noinspection ResultOfMethodCallIgnored
        oldTmp.setLastModified(now - 2 * 86_400_000L);
        store.save(new UpdateBundle.State());
        Set<String> keep = new HashSet<>(Arrays.asList(m.version, B));
        store.prune(keep, now, 86_400_000L);
        Set<String> left = new HashSet<>(Arrays.asList(store.root.list()));
        assertEquals(new HashSet<>(Arrays.asList(m.version, B, "tmp-" + B, "state.json")), left);
        store.deleteAllBundles();
        assertEquals(new HashSet<>(Collections.singletonList("state.json")), new HashSet<>(Arrays.asList(store.root.list())));
    }

    @Test
    public void streamHashing() throws Exception {
        Object[] h = UpdateBundle.sha256Hex(new ByteArrayInputStream(new byte[0]));
        assertEquals(E, h[0]);
        assertEquals(0L, (long) (Long) h[1]);
    }
}
