package app.tinyglow.uploader;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.RandomAccessFile;
import java.nio.channels.Channels;
import java.util.Arrays;
import java.util.List;
import java.util.Random;
import org.junit.Test;

/**
 * JVM unit test of the ranged uploader's slicing (docs/plans/step-12.md 2.9, task 12.9): part sizes,
 * the shorter last part, byte-exact streaming from a seeked file, and that the source is left in
 * place (Android never copies a part, so there is nothing to delete).
 * Run: JAVA_HOME=<jdk 21> ./gradlew testDebugUnitTest --tests 'app.tinyglow.uploader.*'
 */
public class ByteRangeTest {
    private static final long MIB = 1L << 20;
    private static final long PART = 16 * MIB; // UPLOAD_PART_BYTES

    @Test
    public void split60MiBIntoFourPartsWithAShorterLast() {
        List<ByteRange> parts = ByteRange.split(60 * MIB, PART);
        assertEquals(4, parts.size());
        assertEquals(PART, parts.get(0).length);
        assertEquals(PART, parts.get(2).length);
        assertEquals(12 * MIB, parts.get(3).length);
        assertEquals(3 * PART, parts.get(3).offset);
        assertEquals(60 * MIB, parts.get(3).end());
    }

    @Test
    public void splitEdgeCases() {
        assertEquals(2, ByteRange.split(32 * MIB, PART).size()); // no empty tail
        assertEquals(1, ByteRange.split(1, PART).size());
        assertTrue(ByteRange.split(0, PART).isEmpty());
        assertEquals(128, ByteRange.split(2048 * MIB, PART).size()); // 2 GiB: the api's maximum
    }

    @Test
    public void rangeValidation() {
        assertEquals(0, ByteRange.of(100, 0, 100).offset);
        assertTrue(ByteRange.of(100, 0, 100).isWholeFile(100));
        assertTrue(ByteRange.of(100, 0, -1).isWholeFile(100)); // -1 = to the end
        assertEquals(10, ByteRange.of(100, 90, -1).length);
        assertNotNull(ByteRange.of(100, 90, 10)); // last part up to EOF
        assertNull(ByteRange.of(100, 90, 11)); // past the end
        assertNull(ByteRange.of(100, 100, 1)); // offset at EOF
        assertNull(ByteRange.of(100, -1, 1));
        assertNull(ByteRange.of(100, 0, 0));
        assertFalse(ByteRange.of(100, 0, 50).isWholeFile(100));
    }

    @Test
    public void copiesEachPartByteExactFromASeekedFileAndLeavesTheSource() throws Exception {
        byte[] bytes = new byte[(int) (5 * MIB + 3)];
        new Random(42).nextBytes(bytes);
        File source = File.createTempFile("ll-range", ".mov");
        source.deleteOnExit();
        try (FileOutputStream fos = new FileOutputStream(source)) {
            fos.write(bytes);
        }
        List<ByteRange> parts = ByteRange.split(bytes.length, 2 * MIB);
        assertEquals(3, parts.size());
        assertEquals(MIB + 3, parts.get(2).length);
        for (ByteRange p : parts) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (RandomAccessFile raf = new RandomAccessFile(source, "r")) {
                raf.seek(p.offset);
                long sent = ByteRange.copy(Channels.newInputStream(raf.getChannel()), out, p.length, null);
                assertEquals(p.length, sent);
            }
            assertArrayEquals(Arrays.copyOfRange(bytes, (int) p.offset, (int) p.end()), out.toByteArray());
        }
        assertTrue("the source stays in place", source.isFile());
        assertEquals(bytes.length, source.length());
        assertTrue(source.delete());
    }

    @Test
    public void shortSourceIsAnEofNotASilentShortPart() {
        InputStream in = new ByteArrayInputStream(new byte[10]);
        assertThrows(EOFException.class, () -> ByteRange.copy(in, new ByteArrayOutputStream(), 11, null));
    }

    @Test
    public void stopRequestInterruptsTheCopy() {
        InputStream in = new ByteArrayInputStream(new byte[(int) MIB]);
        ByteRange.Progress stop = new ByteRange.Progress() {
            @Override
            public void onProgress(long sent) {}

            @Override
            public boolean isStopped() {
                return true;
            }
        };
        assertThrows(InterruptedIOException.class, () -> ByteRange.copy(in, new ByteArrayOutputStream(), MIB, stop));
    }

    @Test
    public void progressReportsTheFinalByteCount() throws Exception {
        long[] last = { -1 };
        ByteRange.Progress progress = new ByteRange.Progress() {
            @Override
            public void onProgress(long sent) {
                last[0] = sent;
            }

            @Override
            public boolean isStopped() {
                return false;
            }
        };
        ByteRange.copy(new ByteArrayInputStream(new byte[70_000]), new ByteArrayOutputStream(), 70_000, progress);
        assertEquals(70_000, last[0]);
    }

    @Test
    public void skipFullyHonoursTheOffsetOnNonSeekableStreams() throws Exception {
        byte[] bytes = new byte[100];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) i;
        InputStream in = new ByteArrayInputStream(bytes);
        ByteRange.skipFully(in, 90);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteRange.copy(in, out, 10, null);
        assertArrayEquals(Arrays.copyOfRange(bytes, 90, 100), out.toByteArray());
        assertThrows(EOFException.class, () -> ByteRange.skipFully(new ByteArrayInputStream(new byte[5]), 6));
    }
}
