package dev.tether.app.device;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import dev.tether.app.BuildConfig;

/**
 * Firebase Cloud Messaging without google-services.json: the app is initialised by hand from the
 * TETHER_FCM_* values baked in at build time. Builds without them simply have no push.
 */
final class Push {

    private static final String PREFS_FILE = "tether_device";
    private static final String KEY_PUSH_KEY = "push_key";
    private static SharedPreferences prefs;

    private Push() {}

    static boolean configured() {
        return (
            !BuildConfig.FCM_APP_ID.isEmpty() &&
            !BuildConfig.FCM_API_KEY.isEmpty() &&
            !BuildConfig.FCM_PROJECT_ID.isEmpty() &&
            !BuildConfig.FCM_SENDER_ID.isEmpty()
        );
    }

    /** True when a default FirebaseApp exists (ours, or one from a google-services.json build). */
    static synchronized boolean init(Context ctx) {
        Context app = ctx.getApplicationContext();
        if (!FirebaseApp.getApps(app).isEmpty()) return true;
        if (!configured()) return false;
        FirebaseOptions options = new FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.FCM_APP_ID)
            .setApiKey(BuildConfig.FCM_API_KEY)
            .setProjectId(BuildConfig.FCM_PROJECT_ID)
            .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
            .build();
        FirebaseApp.initializeApp(app, options);
        return true;
    }

    static void saveKey(Context ctx, byte[] key) throws Exception {
        SharedPreferences.Editor e = prefs(ctx).edit();
        if (key == null) e.remove(KEY_PUSH_KEY);
        else e.putString(KEY_PUSH_KEY, Base64.encodeToString(key, Base64.NO_WRAP));
        if (!e.commit()) throw new IllegalStateException("could not save the push key");
    }

    static byte[] key(Context ctx) throws Exception {
        String v = prefs(ctx).getString(KEY_PUSH_KEY, null);
        return v == null ? null : Base64.decode(v, Base64.NO_WRAP);
    }

    /** Standard or URL-safe base64, padded or not. */
    static byte[] base64(String s) {
        return Base64.decode(s.trim().replace('-', '+').replace('_', '/'), Base64.DEFAULT);
    }

    @SuppressWarnings("deprecation")
    private static synchronized SharedPreferences prefs(Context ctx) throws Exception {
        if (prefs == null) {
            Context app = ctx.getApplicationContext();
            MasterKey masterKey = new MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
            prefs = EncryptedSharedPreferences.create(
                app,
                PREFS_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
        }
        return prefs;
    }
}
