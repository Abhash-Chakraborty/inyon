package tech.abhashchakraborty.inyon.device

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import tech.abhashchakraborty.inyon.BuildConfig

/**
 * Firebase Cloud Messaging without google-services.json: the app is initialised by hand from the
 * INYON_FCM_* values baked in at build time. Builds without them simply have no push.
 */
internal object Push {

    private const val PREFS_FILE = "inyon_device"
    private const val KEY_PUSH_KEY = "push_key"
    private var prefs: SharedPreferences? = null

    private fun configured() =
        BuildConfig.FCM_APP_ID.isNotEmpty() &&
            BuildConfig.FCM_API_KEY.isNotEmpty() &&
            BuildConfig.FCM_PROJECT_ID.isNotEmpty() &&
            BuildConfig.FCM_SENDER_ID.isNotEmpty()

    /** True when a default FirebaseApp exists (ours, or one from a google-services.json build). */
    @Synchronized
    fun init(ctx: Context): Boolean {
        val app = ctx.applicationContext
        if (FirebaseApp.getApps(app).isNotEmpty()) return true
        if (!configured()) return false
        val options = FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.FCM_APP_ID)
            .setApiKey(BuildConfig.FCM_API_KEY)
            .setProjectId(BuildConfig.FCM_PROJECT_ID)
            .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
            .build()
        FirebaseApp.initializeApp(app, options)
        return true
    }

    fun saveKey(ctx: Context, key: ByteArray?) {
        val e = prefs(ctx).edit()
        if (key == null) e.remove(KEY_PUSH_KEY) else e.putString(KEY_PUSH_KEY, Base64.encodeToString(key, Base64.NO_WRAP))
        check(e.commit()) { "could not save the push key" }
    }

    fun key(ctx: Context): ByteArray? = prefs(ctx).getString(KEY_PUSH_KEY, null)?.let { Base64.decode(it, Base64.NO_WRAP) }

    /** Standard or URL-safe base64, padded or not. */
    fun base64(s: String): ByteArray = Base64.decode(s.trim().replace('-', '+').replace('_', '/'), Base64.DEFAULT)

    @Synchronized
    @Suppress("DEPRECATION")
    private fun prefs(ctx: Context): SharedPreferences {
        prefs?.let { return it }
        val app = ctx.applicationContext
        val masterKey = MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        return EncryptedSharedPreferences.create(
            app,
            PREFS_FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        ).also { prefs = it }
    }
}
