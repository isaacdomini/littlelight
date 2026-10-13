package app.tinyglow;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import app.tinyglow.passkeys.TinyglowPasskeysPlugin;
import app.tinyglow.uploader.TinyglowUploaderPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TinyglowUploaderPlugin.class);
        registerPlugin(TinyglowPasskeysPlugin.class);
        super.onCreate(savedInstanceState);
        createDefaultChannel();
    }

    // FCM posts to channel "default" (AndroidManifest default_notification_channel_id; the API sends
    // channel_id "default"). Harmless when Firebase is not configured.
    private void createDefaultChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.createNotificationChannel(
            new NotificationChannel("default", "Album updates", NotificationManager.IMPORTANCE_DEFAULT)
        );
    }
}
