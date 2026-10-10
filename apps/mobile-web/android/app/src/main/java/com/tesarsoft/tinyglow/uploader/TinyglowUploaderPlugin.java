package com.tesarsoft.tinyglow.uploader;

import androidx.lifecycle.Observer;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
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
 * Bridge `TinyglowUploader` (docs/plans/step-9.md 2.6):
 *   upload({ url, path }) -> { id }; cancel({ id });
 *   events progress { id, sent, total } | done { id, status } | error { id, message }.
 * The work survives the app being backgrounded or killed (WorkManager, expedited, foreground
 * service type dataSync with an "Uploading N photos" notification). URLs and paths are never logged.
 */
@CapacitorPlugin(name = "TinyglowUploader")
public class TinyglowUploaderPlugin extends Plugin {

    private final Set<String> delivered = new HashSet<>();
    private final Set<String> counted = new HashSet<>();
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
            if (counted.remove(id)) UploadWorker.ACTIVE.decrementAndGet();
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
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(UploadWorker.class)
            .setInputData(new Data.Builder().putString(UploadWorker.KEY_URL, url).putString(UploadWorker.KEY_PATH, path).build())
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .addTag(UploadWorker.TAG)
            .build();
        String id = req.getId().toString();
        UploadWorker.ACTIVE.incrementAndGet();
        counted.add(id);
        WorkManager.getInstance(getContext()).enqueue(req);
        JSObject ret = new JSObject();
        ret.put("id", id);
        call.resolve(ret);
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
}
