package dev.dioxus.main

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import tech.abhashchakraborty.inyon.app.Native
import tech.abhashchakraborty.inyon.device.HrefGate
import tech.abhashchakraborty.inyon.device.Notifications

// wry's Logger reads BuildConfig.DEBUG from its own package
typealias BuildConfig = tech.abhashchakraborty.inyon.BuildConfig

/**
 * The app's one window: wry's WebView with the Dioxus app in it (apps/app). It lives in wry's
 * package because the Rust side binds to `dev.dioxus.main`. The phone core runs without it.
 */
class MainActivity : WryActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        insets()
        open(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        open(intent)
    }

    override fun onStart() {
        super.onStart()
        Native.onScreen(this, true)
    }

    override fun onStop() {
        Native.onScreen(this, false)
        super.onStop()
    }

    /**
     * Android 15 draws every app under the system bars, and the keyboard no longer resizes the
     * window, so the page keeps clear of the bars, the camera cutout and the keyboard itself.
     */
    private fun insets() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val night = Native.night()
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { v, w ->
            val bars = w.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = w.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
    }

    /** A tapped notification's path, taken so a recreated window doesn't open it twice. */
    private fun open(intent: Intent?) {
        val href = intent?.getStringExtra(Notifications.EXTRA_HREF) ?: return
        val nonce = intent.getStringExtra(HrefGate.EXTRA_NONCE)
        intent.removeExtra(Notifications.EXTRA_HREF)
        intent.removeExtra(HrefGate.EXTRA_NONCE)
        // the activity is exported, so any app could send this: only Inyon's own notifications get through
        HrefGate.accept(intent.action, href, nonce, HrefGate.nonce(this))?.let(Native::openHref)
    }
}
