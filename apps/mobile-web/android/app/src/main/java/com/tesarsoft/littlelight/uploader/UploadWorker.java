package com.tesarsoft.littlelight.uploader;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.ServiceInfo;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.concurrent.futures.CallbackToFutureAdapter;
import androidx.core.app.NotificationCompat;
import androidx.work.Data;
import androidx.work.ForegroundInfo;
import androidx.work.WorkerParameters;
import androidx.work.Worker;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Raw-body HTTP PUT of one file (docs/plans/step-9.md 2.6). No multipart, no custom headers
 * (the presigned URL signs none). The input URL carries X-Amz-Signature: it is never logged, and
 * only the HTTP status or a short error code leaves this class.
 */
public class UploadWorker extends Worker {
    static final String TAG = "ll-upload";
    static final String KEY_URL = "url";
    static final String KEY_PATH = "path";
    static final String KEY_SENT = "sent";
    static final String KEY_TOTAL = "total";
    static final String KEY_STATUS = "status";
    static final String KEY_ERROR = "error";
    static final String CHANNEL_ID = "uploads";
    private static final int NOTIFICATION_ID = 4711;
    private static final int MAX_ATTEMPTS = 3;

    /** Uploads queued or running in this process; only used for the notification text. */
    static final AtomicInteger ACTIVE = new AtomicInteger();

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
            nm.createNotificationChannel(
                new NotificationChannel(CHANNEL_ID, "Photo uploads", NotificationManager.IMPORTANCE_LOW)
            );
        }
        int n = Math.max(1, ACTIVE.get());
        Notification notification = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(n == 1 ? "Uploading 1 photo" : "Uploading " + n + " photos")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return new ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        }
        return new ForegroundInfo(NOTIFICATION_ID, notification);
    }

    @NonNull
    @Override
    public Result doWork() {
        String url = getInputData().getString(KEY_URL);
        String path = getInputData().getString(KEY_PATH);
        if (url == null || path == null) return fail("bad-args");
        if (path.startsWith("file://")) path = android.net.Uri.parse(path).getPath();
        File file = path == null ? null : new File(path);
        if (file == null || !file.isFile() || !file.canRead()) return fail("file-unreadable");
        long total = file.length();
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            connection = c;
            c.setRequestMethod("PUT");
            c.setDoOutput(true);
            c.setConnectTimeout(30_000);
            c.setReadTimeout(120_000);
            c.setUseCaches(false);
            c.setFixedLengthStreamingMode(total);
            long sent = 0;
            long lastReport = 0;
            try (InputStream in = new FileInputStream(file); OutputStream out = c.getOutputStream()) {
                byte[] buf = new byte[64 * 1024];
                int r;
                while ((r = in.read(buf)) != -1) {
                    if (isStopped()) return Result.failure(error("cancelled"));
                    out.write(buf, 0, r);
                    sent += r;
                    long now = System.currentTimeMillis();
                    if (now - lastReport > 250) {
                        lastReport = now;
                        setProgressAsync(new Data.Builder().putLong(KEY_SENT, sent).putLong(KEY_TOTAL, total).build());
                    }
                }
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
        } catch (java.io.IOException e) {
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
