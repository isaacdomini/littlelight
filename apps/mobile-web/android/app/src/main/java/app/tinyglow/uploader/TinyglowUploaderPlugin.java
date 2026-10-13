package app.tinyglow.uploader;

import androidx.lifecycle.Observer;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Bridge `TinyglowUploader` (docs/plans/step-9.md 2.6; ranged parts docs/plans/step-12.md 2.9):
 *   upload({ url, path, offset?, length?, wifiOnly? }) -> { id }
 *     PUT bytes [offset, offset+length) of the file (default: the whole file) to the presigned URL.
 *     Android streams the range straight from the file or content URI: no copy, nothing to delete.
 *     wifiOnly: true adds an UNMETERED network constraint (the work waits for Wi-Fi).
 *   cancel({ id });  pendingParts() -> { count: 0 } (iOS parity; Android never writes part files)
 *   events progress { id, sent, total } | done { id, status } | error { id, message }.
 * The work survives the app being backgrounded or killed (WorkManager, expedited, foreground
 * service type dataSync with an "Uploading photos and videos" notification). URLs and paths are
 * never logged.
 */
@CapacitorPlugin(name = "TinyglowUploader")
public class TinyglowUploaderPlugin extends Plugin {

    private final Set<String> delivered = new HashSet<>();
    private final Observer<List<WorkInfo>> observer = this::onWork;

    @Override
    public void load() {
        // Observes every tagged work item, so uploads that finished while the app was away are
        // reported (retained until JS listens) and then pruned.
        WorkManager.getInstance(getContext()).getWorkInfosByTagLiveData(UploadWorker.TAG).observeForever(observer);
    }

    @Override
    protected void handleOnDestroy() {
        WorkManager.getInstance(getContext()).getWorkInfosByTagLiveData(UploadWorker.TAG).removeObserver(observer);
    }

    private void onWork(List<WorkInfo> infos) {
        boolean pruneNeeded = false;
        for (WorkInfo info : infos) {
            String id = info.getId().toString();
            WorkInfo.State state = info.getState();
            if (!state.isFinished()) {
                Data p = info.getProgress();
                long total = p.getLong(UploadWorker.KEY_TOTAL, 0);
                if (total > 0) {
                    JSObject o = new JSObject();
                    o.put("id", id);
                    o.put("sent", p.getLong(UploadWorker.KEY_SENT, 0));
                    o.put("total", total);
                    notifyListeners("progress", o);
                }
                continue;
            }
            if (!delivered.add(id)) continue;
            pruneNeeded = true;
            JSObject o = new JSObject();
            o.put("id", id);
            if (state == WorkInfo.State.SUCCEEDED) {
                o.put("status", info.getOutputData().getInt(UploadWorker.KEY_STATUS, 0));
                notifyListeners("done", o, true);
            } else if (state == WorkInfo.State.FAILED) {
                String e = info.getOutputData().getString(UploadWorker.KEY_ERROR);
                o.put("message", e == null ? "network" : e);
                notifyListeners("error", o, true);
            }
            // CANCELLED: the caller asked for it, no event.
        }
        if (pruneNeeded) WorkManager.getInstance(getContext()).pruneWork();
    }

    @PluginMethod
    public void upload(PluginCall call) {
        String url = call.getString("url");
        String path = call.getString("path");
        if (url == null || path == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("bad-args");
            return;
        }
        // Range: JSON numbers arrive as Double/Long; -1 means "to the end". Validated in the worker
        // against the real file size (the file may not be readable from this thread cheaply).
        long offset = longArg(call, "offset", 0);
        long length = longArg(call, "length", -1);
        if (offset < 0 || length == 0 || length < -1) {
            call.reject("bad-args");
            return;
        }
        boolean wifiOnly = Boolean.TRUE.equals(call.getBoolean("wifiOnly", false));
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(UploadWorker.class)
            .setInputData(
                new Data.Builder()
                    .putString(UploadWorker.KEY_URL, url)
                    .putString(UploadWorker.KEY_PATH, path)
                    .putLong(UploadWorker.KEY_OFFSET, offset)
                    .putLong(UploadWorker.KEY_LENGTH, length)
                    .build()
            )
            .setConstraints(
                new Constraints.Builder().setRequiredNetworkType(wifiOnly ? NetworkType.UNMETERED : NetworkType.CONNECTED).build()
            )
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .addTag(UploadWorker.TAG)
            .build();
        String id = req.getId().toString();
        WorkManager.getInstance(getContext()).enqueue(req);
        JSObject ret = new JSObject();
        ret.put("id", id);
        call.resolve(ret);
    }

    private static long longArg(PluginCall call, String key, long fallback) {
        Object v = call.getData().opt(key);
        if (v instanceof Number) return ((Number) v).longValue();
        return fallback;
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        try {
            WorkManager.getInstance(getContext()).cancelWorkById(UUID.fromString(id));
        } catch (RuntimeException e) {
            call.reject("bad-args");
            return;
        }
        call.resolve();
    }

    /** Android streams ranges in place and keeps no part copies: always 0 (same shape as iOS). */
    @PluginMethod
    public void pendingParts(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("count", 0);
        call.resolve(ret);
    }
}
