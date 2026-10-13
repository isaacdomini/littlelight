package app.tinyglow.uploader;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * One part of a file for the ranged uploader (docs/plans/step-12.md 2.9): [offset, offset + length)
 * inside a file of {@code fileSize} bytes. Pure Java (no Android imports) so the unit test runs on
 * the JVM. Android never copies a part: the worker seeks the source and streams exactly
 * {@code length} bytes into the PUT body.
 */
public final class ByteRange {
    public final long offset;
    public final long length;

    private ByteRange(long offset, long length) {
        this.offset = offset;
        this.length = length;
    }

    public long end() {
        return offset + length;
    }

    /** True when the range covers the whole file (the worker then streams from byte 0 to EOF). */
    public boolean isWholeFile(long fileSize) {
        return offset == 0 && length == fileSize;
    }

    /**
     * Validates a requested range. {@code length < 0} means "to the end of the file". Returns null
     * for a negative offset, a zero length, or a range that leaves the file.
     */
    @Nullable
    public static ByteRange of(long fileSize, long offset, long length) {
        if (fileSize < 0 || offset < 0) return null;
        if (length < 0) length = fileSize - offset;
        if (length < 1) return null;
        if (offset >= fileSize || length > fileSize - offset) return null;
        return new ByteRange(offset, length);
    }

    /**
     * Every part of a {@code fileSize}-byte file in {@code partSize} slices; the last one may be
     * shorter (mirror of {@code partCountFor} in {@code @tinyglow/shared}).
     */
    @NonNull
    public static List<ByteRange> split(long fileSize, long partSize) {
        List<ByteRange> parts = new ArrayList<>();
        if (fileSize <= 0 || partSize <= 0) return parts;
        for (long offset = 0; offset < fileSize; ) {
            long length = Math.min(partSize, fileSize - offset);
            parts.add(new ByteRange(offset, length));
            offset += length;
        }
        return parts;
    }

    /** Progress and cancellation hooks for {@link #copy}. */
    public interface Progress {
        /** Called at most every ~250 ms and once at the end with the bytes written so far. */
        void onProgress(long sent);

        /** True when the caller wants the copy to stop (WorkManager {@code isStopped}). */
        boolean isStopped();
    }

    /**
     * Streams exactly {@code length} bytes from {@code in} (already positioned at the range start)
     * to {@code out}. Throws {@link EOFException} when the source ends early and
     * {@link InterruptedIOException} when {@code progress.isStopped()} turns true. Returns the bytes
     * written (always {@code length} on success). Neither stream is closed.
     */
    public static long copy(@NonNull InputStream in, @NonNull OutputStream out, long length, @Nullable Progress progress)
        throws IOException {
        byte[] buf = new byte[64 * 1024];
        long sent = 0;
        long lastReport = 0;
        while (sent < length) {
            if (progress != null && progress.isStopped()) throw new java.io.InterruptedIOException("cancelled");
            int want = (int) Math.min(buf.length, length - sent);
            int r = in.read(buf, 0, want);
            if (r == -1) throw new EOFException("source ended after " + sent + " of " + length + " bytes");
            out.write(buf, 0, r);
            sent += r;
            if (progress != null) {
                long now = System.currentTimeMillis();
                if (now - lastReport > 250) {
                    lastReport = now;
                    progress.onProgress(sent);
                }
            }
        }
        if (progress != null) progress.onProgress(sent);
        return sent;
    }

    /** Skips exactly {@code n} bytes of a stream that cannot seek (content providers). */
    public static void skipFully(@NonNull InputStream in, long n) throws IOException {
        while (n > 0) {
            long s = in.skip(n);
            if (s <= 0) {
                if (in.read() == -1) throw new EOFException("offset beyond the end of the source");
                s = 1;
            }
            n -= s;
        }
    }

    @Override
    public boolean equals(Object o) {
        if (!(o instanceof ByteRange)) return false;
        ByteRange b = (ByteRange) o;
        return b.offset == offset && b.length == length;
    }

    @Override
    public int hashCode() {
        return Long.hashCode(offset) * 31 + Long.hashCode(length);
    }

    @Override
    @NonNull
    public String toString() {
        return "ByteRange[" + offset + "+" + length + "]";
    }
}
