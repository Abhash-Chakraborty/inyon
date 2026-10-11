package dev.tether.app.device

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat

/**
 * A foreground service with nothing to do but exist: while it runs, Android keeps the app process
 * (and with it the WebView's renderer) out of the cached state, so sockets stay open and the web
 * app keeps getting live updates in the background.
 */
class KeepAliveService : Service() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Tether"
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Connected"
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        try {
            ServiceCompat.startForeground(this, Notifications.KEEP_ALIVE_ID, Notifications.keepAlive(this, title, text), type)
            running = true
        } catch (e: RuntimeException) {
            // e.g. the daily dataSync allowance (Android 15+) is used up
            Log.w(TAG, "could not start in the foreground: $e")
            stop("error")
        }
        // if the process dies the WebView is gone too, so there's nothing to restart for
        return START_NOT_STICKY
    }

    /** Android 15+: dataSync services get 6 hours a day, reset whenever the app is opened. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        stop("timeout")
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun stop(reason: String) {
        running = false
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
        TetherDevicePlugin.keepAliveEnded(reason)
    }

    companion object {
        private const val TAG = "TetherKeepAlive"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"

        @Volatile
        var running = false
            private set

        fun intent(ctx: Context, title: String?, text: String?): Intent =
            Intent(ctx, KeepAliveService::class.java).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TEXT, text)
    }
}
