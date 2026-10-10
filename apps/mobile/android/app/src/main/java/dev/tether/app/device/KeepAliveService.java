package dev.tether.app.device;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.ServiceCompat;

/**
 * A foreground service with nothing to do but exist: while it runs, Android keeps the app process
 * (and with it the WebView's renderer) out of the cached state, so sockets stay open and the web
 * app keeps getting live updates in the background.
 */
public class KeepAliveService extends Service {

    private static final String TAG = "TetherKeepAlive";
    private static final String EXTRA_TITLE = "title";
    private static final String EXTRA_TEXT = "text";

    private static volatile boolean running;

    static boolean isRunning() {
        return running;
    }

    static Intent intent(Context ctx, String title, String text) {
        return new Intent(ctx, KeepAliveService.class).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TEXT, text);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
        try {
            ServiceCompat.startForeground(
                this,
                Notifications.KEEP_ALIVE_ID,
                Notifications.keepAlive(this, title != null ? title : "Tether", text != null ? text : "Connected"),
                type
            );
            running = true;
        } catch (RuntimeException e) {
            // e.g. the daily dataSync allowance (Android 15+) is used up
            Log.w(TAG, "could not start in the foreground: " + e);
            stop("error");
        }
        // if the process dies the WebView is gone too, so there's nothing to restart for
        return START_NOT_STICKY;
    }

    /** Android 15+: dataSync services get 6 hours a day, reset whenever the app is opened. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        stop("timeout");
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void stop(String reason) {
        running = false;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
        TetherDevicePlugin.keepAliveEnded(reason);
    }
}
