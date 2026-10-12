package tech.abhashchakraborty.inyon.device

import android.app.Application
import android.util.Log

class InyonApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        // before any service runs: a push can start the process with no activity
        try {
            Push.init(this)
        } catch (e: RuntimeException) {
            Log.w("InyonPush", "push disabled: $e")
        }
    }
}
