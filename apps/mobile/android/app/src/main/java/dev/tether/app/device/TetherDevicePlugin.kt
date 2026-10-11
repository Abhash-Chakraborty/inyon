package dev.tether.app.device

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import androidx.core.view.inputmethod.InputConnectionCompat
import androidx.core.view.inputmethod.InputContentInfoCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.google.firebase.messaging.FirebaseMessaging
import java.util.concurrent.Executors
import org.json.JSONObject

/** Phone-only features: keyboard/clipboard files, background keep-alive, notifications, push, haptics and QR scanning. */
@CapacitorPlugin(
    name = "TetherDevice",
    permissions = [Permission(alias = TetherDevicePlugin.NOTIFICATIONS, strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class TetherDevicePlugin : Plugin() {

    private val pool = Executors.newCachedThreadPool()
    private val haptics by lazy { Haptics(context) }

    @Volatile private var launchHref: String? = null
    private var savedRendererPriority: Int? = null
    private var savedRendererWaived = false

    override fun load() {
        live = this
        Notifications.ensureChannels(context)
        (bridge.webView as? TetherWebView)?.contentListener = TetherWebView.ContentListener(::onKeyboardContent)
        // a notification tapped while the app wasn't running started the activity itself
        activity?.intent?.let { intent -> openedHref(intent)?.let { launchHref = it } }
        // the release smoke test looks for this line
        Log.i(TAG, "ready")
    }

    override fun handleOnNewIntent(intent: Intent) {
        val href = openedHref(intent) ?: return
        if (hasListeners("pushOpened")) {
            notifyListeners("pushOpened", JSObject().put("href", href))
        } else {
            // cold start: the web app isn't listening yet and asks with takeLaunchHref()
            launchHref = href
        }
    }

    /** The in-app path a tapped notification carries, consumed so a recreated activity doesn't open it twice. */
    private fun openedHref(intent: Intent): String? {
        val href = intent.getStringExtra(Notifications.EXTRA_HREF) ?: return null
        intent.removeExtra(Notifications.EXTRA_HREF)
        // the activity is exported, so any app could send this: only in-app paths get through
        if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/\\")) return null
        return href
    }

    override fun handleOnStop() {
        // Capacitor only pauses the WebView when KeepRunning is false (it isn't here), but undo any
        // pause anyway while the user asked to stay connected
        if (KeepAliveService.running) {
            val webView = bridge.webView
            webView.onResume()
            webView.resumeTimers()
        }
    }

    override fun handleOnDestroy() {
        if (live === this) live = null
        (bridge.webView as? TetherWebView)?.contentListener = null
        // the WebView goes with the activity, so there is nothing left to keep alive
        if (KeepAliveService.running) context.stopService(Intent(context, KeepAliveService::class.java))
        pool.shutdown()
    }

    // ---- files and text from the keyboard and the clipboard --------------------------------

    private fun onKeyboardContent(content: InputContentInfoCompat, flags: Int): Boolean {
        if (!hasListeners("pasteFile")) return false
        var granted = false
        if (Build.VERSION.SDK_INT >= 25 && flags and InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION != 0) {
            try {
                content.requestPermission()
                granted = true
            } catch (e: Exception) {
                Log.w(TAG, "keyboard content permission refused: $e")
                return false
            }
        }
        val release = granted
        val description = content.description
        val typeHint = if (description.mimeTypeCount > 0) description.getMimeType(0) else null
        val uri = content.contentUri
        pool.execute {
            try {
                notifyListeners("pasteFile", ContentReader.read(context, uri, typeHint))
            } catch (e: Exception) {
                pasteError(e)
            } finally {
                if (release) content.releasePermission()
            }
        }
        return true
    }

    private fun pasteError(e: Exception) {
        Log.w(TAG, "could not read pasted content: $e")
        val message = if (e is ContentReader.TooLargeException) e.message else "Couldn't read the pasted file"
        notifyListeners("pasteError", JSObject().put("message", message))
    }

    @PluginMethod
    fun readClipboardFile(call: PluginCall) {
        pool.execute {
            try {
                val clip = clipboard()?.primaryClip
                if (clip != null) {
                    val d = clip.description
                    for (i in 0 until clip.itemCount) {
                        val uri = clip.getItemAt(i).uri ?: continue
                        val hint = d?.let { (0 until it.mimeTypeCount).map(it::getMimeType).firstOrNull { t -> !t.startsWith("text/") && !t.contains("*") } }
                        call.resolve(ContentReader.read(context, uri, hint))
                        return@execute
                    }
                }
                call.resolve(JSObject())
            } catch (e: ContentReader.TooLargeException) {
                call.reject(e.message, "TOO_LARGE")
            } catch (e: Exception) {
                call.reject("Couldn't read the clipboard: ${e.message}", "ERROR")
            }
        }
    }

    /** The WebView refuses navigator.clipboard.readText(), so text paste comes through here. */
    @PluginMethod
    fun readClipboardText(call: PluginCall) {
        pool.execute {
            try {
                val clip = clipboard()?.primaryClip
                val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(context)?.toString() else null
                call.resolve(JSObject().put("text", text ?: ""))
            } catch (e: Exception) {
                call.reject("Couldn't read the clipboard: ${e.message}", "ERROR")
            }
        }
    }

    private fun clipboard() = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager?

    // ---- staying connected in the background -----------------------------------------------

    @PluginMethod
    fun startKeepAlive(call: PluginCall) {
        try {
            ContextCompat.startForegroundService(context, KeepAliveService.intent(context, call.getString("title"), call.getString("text")))
        } catch (e: IllegalStateException) {
            // Android 12+ refuses to start a foreground service while the app is in the background
            return call.reject("Can't start the background connection right now: ${e.message}", "NOT_ALLOWED")
        }
        bridge.executeOnMainThread { rendererImportant(true) }
        call.resolve(ok())
    }

    @PluginMethod
    fun updateKeepAlive(call: PluginCall) {
        if (KeepAliveService.running) {
            Notifications.updateKeepAlive(context, call.getString("title") ?: "Tether", call.getString("text") ?: "Connected")
        }
        call.resolve(ok())
    }

    @PluginMethod
    fun stopKeepAlive(call: PluginCall) {
        context.stopService(Intent(context, KeepAliveService::class.java))
        bridge.executeOnMainThread { rendererImportant(false) }
        call.resolve(ok())
    }

    private fun onKeepAliveEnded(reason: String) {
        bridge.executeOnMainThread { rendererImportant(false) }
        notifyListeners("keepAliveStopped", JSObject().put("reason", reason))
    }

    /** Keeps the renderer process as important as the app while hidden; restores the old policy after. */
    private fun rendererImportant(on: Boolean) {
        if (Build.VERSION.SDK_INT < 26) return
        val webView = bridge.webView
        if (on) {
            if (savedRendererPriority == null) {
                savedRendererPriority = webView.rendererRequestedPriority
                savedRendererWaived = webView.rendererPriorityWaivedWhenNotVisible
            }
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        } else {
            savedRendererPriority?.let {
                webView.setRendererPriorityPolicy(it, savedRendererWaived)
                savedRendererPriority = null
            }
        }
    }

    @PluginMethod
    fun isIgnoringBatteryOptimizations(call: PluginCall) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager?
        call.resolve(JSObject().put("ignoring", pm != null && pm.isIgnoringBatteryOptimizations(context.packageName)))
    }

    /** The system list where the user can exempt Tether; the app details page where that list is missing. */
    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        bridge.executeOnMainThread {
            try {
                activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: ActivityNotFoundException) {
                try {
                    activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
                } catch (_: ActivityNotFoundException) {
                    return@executeOnMainThread call.reject("No battery settings screen on this device", "UNAVAILABLE")
                }
            }
            call.resolve(ok())
        }
    }

    // ---- notifications and push ------------------------------------------------------------

    @PluginMethod
    fun notificationsEnabled(call: PluginCall) {
        call.resolve(JSObject().put("enabled", Notifications.canPost(context)))
    }

    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            notificationPermissionResult(call)
        } else {
            requestPermissionForAlias(NOTIFICATIONS, call, "notificationPermissionResult")
        }
    }

    @PermissionCallback
    private fun notificationPermissionResult(call: PluginCall) {
        call.resolve(JSObject().put("granted", Notifications.canPost(context)))
    }

    /** An agent or machine event, with the app's logo and buttons; the same tag replaces the last one. */
    @PluginMethod
    fun postNotification(call: PluginCall) {
        val posted = Notifications.post(
            context,
            call.getString("title") ?: "Tether",
            call.getString("body") ?: "",
            call.getString("href"),
            call.getString("tag"),
            call.getString("kind"),
        )
        call.resolve(ok().put("posted", posted))
    }

    @PluginMethod
    fun clearNotification(call: PluginCall) {
        call.getString("tag")?.let { Notifications.clear(context, it) }
        call.resolve(ok())
    }

    // registration tokens are what the hub sends to; the installation-ID registration that
    // firebase-messaging 25.1 deprecates them for is opt-in and needs a different send path
    @PluginMethod
    @Suppress("DEPRECATION")
    fun pushToken(call: PluginCall) {
        val messaging = try {
            if (!Push.init(context)) return call.resolve(failure("Push isn't set up in this build"))
            FirebaseMessaging.getInstance().also {
                // auto-init is off in the manifest so unconfigured builds stay quiet; once the web app
                // asks for a token, let the SDK keep it fresh
                it.isAutoInitEnabled = true
            }
        } catch (e: RuntimeException) {
            return call.resolve(failure("Push isn't available: ${e.message}"))
        }
        messaging.token.addOnCompleteListener { task ->
            val token = if (task.isSuccessful) task.result else null
            if (token != null) {
                call.resolve(JSObject().put("token", token))
            } else {
                call.resolve(failure(task.exception?.message ?: "Couldn't get a push token"))
            }
        }
    }

    private fun onToken(token: String) {
        notifyListeners("pushToken", JSObject().put("token", token))
    }

    /** The AES-256-GCM key the hub encrypts pushes with; null or empty clears it. */
    @PluginMethod
    fun setPushKey(call: PluginCall) {
        val key = call.getString("key")
        val bytes = if (key.isNullOrEmpty()) {
            null
        } else {
            val decoded = try {
                Push.base64(key)
            } catch (_: IllegalArgumentException) {
                return call.reject("key must be base64", "BAD_REQUEST")
            }
            if (decoded.size != PushCrypto.KEY_BYTES) return call.reject("key must be 32 bytes", "BAD_REQUEST")
            decoded
        }
        pool.execute {
            try {
                Push.saveKey(context, bytes)
                call.resolve(ok())
            } catch (e: Exception) {
                call.reject("Couldn't save the push key: ${e.message}", "ERROR")
            }
        }
    }

    @PluginMethod
    fun takeLaunchHref(call: PluginCall) {
        // the web app asks once as it starts; the release smoke test looks for this line
        Log.i(TAG, "web app started")
        val href = launchHref
        launchHref = null
        call.resolve(JSObject().put("href", href ?: JSONObject.NULL))
    }

    // ---- haptics ---------------------------------------------------------------------------

    @PluginMethod
    fun haptic(call: PluginCall) {
        val kind = call.getString("kind") ?: "tap"
        if (kind !in Haptics.KINDS) return call.reject("unknown haptic kind: $kind", "BAD_REQUEST")
        call.resolve(JSObject().put("played", haptics.play(kind, bridge.webView)))
    }

    // ---- QR codes --------------------------------------------------------------------------

    /** Opens the scanner; resolves { text }, { paste: true }, { denied: true } or { cancelled: true }. */
    @PluginMethod
    fun scanQr(call: PluginCall) {
        val intent = ScannerActivity.intent(context, call.getBoolean("haptics", true) ?: true)
        bridge.executeOnMainThread { startActivityForResult(call, intent, "scanResult") }
    }

    @ActivityCallback
    private fun scanResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val data = result.data
        when {
            result.resultCode != Activity.RESULT_OK || data == null -> call.resolve(cancelled())
            data.hasExtra(ScannerActivity.EXTRA_TEXT) -> call.resolve(JSObject().put("text", data.getStringExtra(ScannerActivity.EXTRA_TEXT) ?: ""))
            data.getBooleanExtra(ScannerActivity.EXTRA_PASTE, false) -> call.resolve(JSObject().put("paste", true))
            data.getBooleanExtra(ScannerActivity.EXTRA_DENIED, false) -> call.resolve(JSObject().put("denied", true))
            else -> call.resolve(cancelled())
        }
    }

    companion object {
        const val NOTIFICATIONS = "notifications"
        private const val TAG = "TetherDevice"

        // the services outlive the activity, so they reach the web app through whichever instance is live
        @Volatile private var live: TetherDevicePlugin? = null

        fun keepAliveEnded(reason: String) {
            live?.onKeepAliveEnded(reason)
        }

        fun emitToken(token: String) {
            live?.onToken(token)
        }

        private fun ok(): JSObject = JSObject().put("ok", true)

        private fun failure(message: String): JSObject = JSObject().put("error", message)

        private fun cancelled(): JSObject = JSObject().put("cancelled", true)
    }
}
