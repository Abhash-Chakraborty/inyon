package tech.abhashchakraborty.inyon.device

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
import java.util.concurrent.Executors
import org.json.JSONObject

/** Phone-only features: keyboard/clipboard files, background keep-alive, notifications, haptics and QR scanning. */
@CapacitorPlugin(
    name = "InyonDevice",
    permissions = [Permission(alias = InyonDevicePlugin.NOTIFICATIONS, strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class InyonDevicePlugin : Plugin() {

    private val pool = Executors.newCachedThreadPool()
    private val haptics by lazy { Haptics(context) }

    @Volatile private var launchHref: String? = null
    private var savedRendererPriority: Int? = null
    private var savedRendererWaived = false

    override fun load() {
        live = this
        Notifications.ensureChannels(context)
        (bridge.webView as? InyonWebView)?.contentListener = InyonWebView.ContentListener(::onKeyboardContent)
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
        (bridge.webView as? InyonWebView)?.contentListener = null
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
            Notifications.updateKeepAlive(context, call.getString("title") ?: "Inyon", call.getString("text") ?: "Connected")
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

    /**
     * Android's own "let this app run in the background?" prompt: one tap, unlike the settings list.
     * Resolves once it's answered, with whether Inyon is now unrestricted.
     */
    @PluginMethod
    fun requestBatteryExemption(call: PluginCall) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager?
        if (pm == null || pm.isIgnoringBatteryOptimizations(context.packageName)) return call.resolve(JSObject().put("ignoring", pm != null))
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        try {
            startActivityForResult(call, intent, "batteryExemptionResult")
        } catch (_: ActivityNotFoundException) {
            // some phones leave the prompt out: the settings list is the next best thing
            openBatterySettings(call)
        }
    }

    @ActivityCallback
    private fun batteryExemptionResult(call: PluginCall?, @Suppress("UNUSED_PARAMETER") result: ActivityResult) {
        if (call == null) return
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager?
        call.resolve(JSObject().put("ignoring", pm != null && pm.isIgnoringBatteryOptimizations(context.packageName)))
    }

    /** The system list where the user can exempt Inyon; the app details page where that list is missing. */
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
            call.getString("title") ?: "Inyon",
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

    /** Opens the scanner; resolves { text }, { type: true }, { denied: true } or { cancelled: true }. */
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
            data.getBooleanExtra(ScannerActivity.EXTRA_TYPE, false) -> call.resolve(JSObject().put("type", true))
            data.getBooleanExtra(ScannerActivity.EXTRA_DENIED, false) -> call.resolve(JSObject().put("denied", true))
            else -> call.resolve(cancelled())
        }
    }

    companion object {
        const val NOTIFICATIONS = "notifications"
        private const val TAG = "InyonDevice"

        // the services outlive the activity, so they reach the web app through whichever instance is live
        @Volatile private var live: InyonDevicePlugin? = null

        fun keepAliveEnded(reason: String) {
            live?.onKeepAliveEnded(reason)
        }

        private fun ok(): JSObject = JSObject().put("ok", true)

        private fun failure(message: String): JSObject = JSObject().put("error", message)

        private fun cancelled(): JSObject = JSObject().put("cancelled", true)
    }
}
