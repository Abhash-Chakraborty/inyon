package dev.tether.app.device;

import android.util.Log;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import org.json.JSONObject;

/**
 * Data messages from the hub. The payload is end-to-end encrypted with the key the web app set
 * through {@code setPushKey}, so Google only ever sees ciphertext. Shown even in the foreground;
 * the web app dedupes against its own in-app notice.
 */
public class TetherMessagingService extends FirebaseMessagingService {

    private static final String TAG = "TetherPush";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        String p = message.getData().get("p");
        if (p == null) return;
        try {
            byte[] key = Push.key(this);
            if (key == null) {
                Log.w(TAG, "push received but no key is set");
                return;
            }
            JSONObject o = new JSONObject(PushCrypto.decrypt(key, Push.base64(p)));
            String title = str(o, "title");
            String body = str(o, "body");
            Notifications.post(this, title != null ? title : "Tether", body != null ? body : "", str(o, "href"), str(o, "tag"), str(o, "kind"));
        } catch (Exception e) {
            Log.w(TAG, "could not open a push: " + e);
        }
    }

    @Override
    @SuppressWarnings("deprecation") // see TetherDevicePlugin.pushToken
    public void onNewToken(String token) {
        TetherDevicePlugin.emitToken(token);
    }

    private static String str(JSONObject o, String name) {
        Object v = o.opt(name);
        return v instanceof String s && !s.isEmpty() ? s : null;
    }
}
