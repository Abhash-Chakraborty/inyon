package dev.tether.app.device;

import android.app.Application;
import android.util.Log;

public class TetherApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        // before any service runs: a push can start the process with no activity
        try {
            Push.init(this);
        } catch (RuntimeException e) {
            Log.w("TetherPush", "push disabled: " + e);
        }
    }
}
