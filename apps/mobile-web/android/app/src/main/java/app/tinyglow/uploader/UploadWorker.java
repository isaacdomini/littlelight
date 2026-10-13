package app.tinyglow.uploader;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.concurrent.futures.CallbackToFutureAdapter;
import androidx.core.app.NotificationCompat;
import androidx.work.Data;
import androidx.work.ForegroundInfo;
import androidx.work.WorkerParameters;
import androidx.work.Worker;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.channels.Channels;

/**
 * Raw-body HTTP PUT of one byte range of a file (docs/plans/step-9.md 2.6; ranged parts
 * docs/plans/step-12.md 2.9). No multipart, no custom headers (the presigned URL signs none). The
 * range is streamed from the source (RandomAccessFile for files, a seeked descriptor for content
 * URIs): nothing is copied, so there is nothing to clean up. The input URL carries
 * X-Amz-Signature: it is never logged, and only the HTTP status or a short error code leaves this class.
 */
public class UploadWorker extends Worker {
    static final String TAG = "ll-upload";
    static final String KEY_URL = "url";
    static final String KEY_PATH = "path";
    static final String KEY_OFFSET = "offset";
    static final String KEY_LENGTH = "length";
    static final String KEY_SENT = "sent";
    static final String KEY_TOTAL = "total";
    static final String KEY_STATUS = "status";
    static final String KEY_ERROR = "error";
    static final String CHANNEL_ID = "uploads";
    private static final int NOTIFICATION_ID = 4711;
    private static final int MAX_ATTEMPTS = 3;

    private volatile HttpURLConnection connection;

    public UploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public ListenableFuture<ForegroundInfo> getForegroundInfoAsync() {
        return CallbackToFutureAdapter.getFuture(completer -> {
            completer.set(foregroundInfo());
            return "ll-upload-foreground";
        });
    }

    private ForegroundInfo foregroundInfo() {
        Context ctx = getApplicationContext();
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Uploads", NotificationManager.IMPORTANCE_LOW));
        }
        // One notification for every queued part; a count would count parts, not photos, so none is shown.
        Notification notification = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Uploading photos and videos")
            .setContentText("Tinyglow keeps uploading while you do other things.")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return new ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        }
        return new ForegroundInfo(NOTIFICATION_ID, notification);
    }

    /** The opened, range-positioned source and its total size. */
    private static final class Source implements AutoCloseable {
        final InputStream in;
        final long fileSize;
        private final AutoCloseable owner;

        Source(InputStream in, long fileSize, AutoCloseable owner) {
            this.in = in;
            this.fileSize = fileSize;
            this.owner = owner;
        }

        @Override
        public void close() {
            try {
                in.close();
            } catch (Exception ignored) {
                // closing
            }
            try {
                if (owner != null) owner.close();
            } catch (Exception ignored) {
                // closing
            }
        }
    }

    /** Opens the source and seeks to {@code offset}; null when unreadable. */
    @Nullable
    private Source open(String path, long offset) throws IOException {
        if (path.startsWith("content://")) {
            ParcelFileDescriptor pfd = getApplicationContext().getContentResolver().openFileDescriptor(Uri.parse(path), "r");
            if (pfd == null) return null;
            long size = pfd.getStatSize();
            if (size < 0) {
                pfd.close();
                return null;
            }
            FileInputStream fis = new FileInputStream(pfd.getFileDescriptor());
            try {
                fis.getChannel().position(offset);
            } catch (IOException notSeekable) {
                ByteRange.skipFully(fis, offset);
            }
            return new Source(fis, size, pfd);
        }
        if (path.startsWith("file://")) path = Uri.parse(path).getPath();
        File file = path == null ? null : new File(path);
        if (file == null || !file.isFile() || !file.canRead()) return null;
        RandomAccessFile raf = new RandomAccessFile(file, "r");
        raf.seek(offset);
        return new Source(Channels.newInputStream(raf.getChannel()), raf.length(), raf);
    }

    @NonNull
    @Override
    public Result doWork() {
        String url = getInputData().getString(KEY_URL);
        String path = getInputData().getString(KEY_PATH);
        long offset = getInputData().getLong(KEY_OFFSET, 0);
        long length = getInputData().getLong(KEY_LENGTH, -1);
        if (url == null || path == null || offset < 0) return fail("bad-args");
        try (Source src = open(path, 0)) {
            if (src == null) return fail("file-unreadable");
            ByteRange range = ByteRange.of(src.fileSize, offset, length);
            if (range == null) return fail(src.fileSize == 0 ? "file-unreadable" : "bad-range");
            length = range.length;
        } catch (IOException e) {
            return fail("file-unreadable");
        }
        final long total = length;
        try (Source src = open(path, offset)) {
            if (src == null) return fail("file-unreadable");
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            connection = c;
            c.setRequestMethod("PUT");
            c.setDoOutput(true);
            c.setConnectTimeout(30_000);
            c.setReadTimeout(120_000);
            c.setUseCaches(false);
            c.setFixedLengthStreamingMode(total);
            try (OutputStream out = c.getOutputStream()) {
                ByteRange.copy(
                    src.in,
                    out,
                    total,
                    new ByteRange.Progress() {
                        @Override
                        public void onProgress(long sent) {
                            setProgressAsync(new Data.Builder().putLong(KEY_SENT, sent).putLong(KEY_TOTAL, total).build());
                        }

                        @Override
                        public boolean isStopped() {
                            return UploadWorker.this.isStopped();
                        }
                    }
                );
            }
            int status = c.getResponseCode();
            try {
                InputStream body = status >= 400 ? c.getErrorStream() : c.getInputStream();
                if (body != null) body.close();
            } catch (Exception ignored) {
                // response body is irrelevant
            }
            return Result.success(
                new Data.Builder().putInt(KEY_STATUS, status).putLong(KEY_SENT, total).putLong(KEY_TOTAL, total).build()
            );
        } catch (InterruptedIOException e) {
            return Result.failure(error("cancelled"));
        } catch (java.io.EOFException e) {
            // The file shrank or vanished under us: not a network problem, do not retry.
            return fail("file-unreadable");
        } catch (IOException e) {
            if (isStopped()) return Result.failure(error("cancelled"));
            if (getRunAttemptCount() + 1 < MAX_ATTEMPTS) return Result.retry();
            return fail("network");
        } finally {
            HttpURLConnection c = connection;
            if (c != null) c.disconnect();
        }
    }

    @Override
    public void onStopped() {
        HttpURLConnection c = connection;
        if (c != null) c.disconnect();
    }

    private static Data error(String code) {
        return new Data.Builder().putString(KEY_ERROR, code).build();
    }

    private static Result fail(String code) {
        return Result.failure(error(code));
    }
}
