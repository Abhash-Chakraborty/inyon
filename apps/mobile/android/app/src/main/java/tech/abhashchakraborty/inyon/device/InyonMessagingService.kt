package tech.abhashchakraborty.inyon.device

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * Data messages from the hub. The payload is end-to-end encrypted with the key the web app set
 * through `setPushKey`, so Google only ever sees ciphertext. Shown even in the foreground; the web
 * app dedupes against its own in-app notice.
 */
class InyonMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val p = message.data["p"] ?: return
        try {
            val key = Push.key(this)
            if (key == null) {
                Log.w(TAG, "push received but no key is set")
                return
            }
            val o = JSONObject(PushCrypto.decrypt(key, Push.base64(p)))
            Notifications.post(this, o.str("title") ?: "Inyon", o.str("body") ?: "", o.str("href"), o.str("tag"), o.str("kind"))
        } catch (e: Exception) {
            Log.w(TAG, "could not open a push: $e")
        }
    }

    override fun onNewToken(token: String) {
        InyonDevicePlugin.emitToken(token)
    }

    private companion object {
        const val TAG = "InyonPush"

        fun JSONObject.str(name: String): String? = (opt(name) as? String)?.ifEmpty { null }
    }
}
