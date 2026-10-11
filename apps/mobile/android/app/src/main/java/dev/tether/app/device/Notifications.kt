package dev.tether.app.device

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.tether.app.MainActivity
import dev.tether.app.R
import java.util.concurrent.atomic.AtomicInteger

/** Notification channels and the kinds of notification the app posts itself. */
internal object Notifications {

    const val ACTION_OPEN_HREF = "dev.tether.app.action.OPEN_HREF"
    const val EXTRA_HREF = "dev.tether.app.extra.HREF"
    const val CHANNEL_CONNECTION = "connection"
    const val CHANNEL_AGENTS = "agents"
    const val KEEP_ALIVE_ID = 7001

    private const val ACCENT = 0xFFD97757.toInt()
    private const val TAGGED_ID = 7002
    private val nextId = AtomicInteger((System.currentTimeMillis() / 1000 % 1_000_000).toInt() + 10_000)

    fun ensureChannels(ctx: Context) {
        val nm = NotificationManagerCompat.from(ctx)
        nm.createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL_CONNECTION, NotificationManagerCompat.IMPORTANCE_LOW)
                .setName("Connection")
                .setDescription("Shown while Tether stays connected in the background")
                .setShowBadge(false)
                .build(),
        )
        nm.createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL_AGENTS, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName("Agents")
                .setDescription("Agents that finished or need your input")
                .build(),
        )
    }

    fun canPost(ctx: Context): Boolean {
        if (
            Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled()
    }

    /** Opens (or brings back) the app; with an href, the plugin hands it to the web app. */
    private fun openApp(ctx: Context, href: String?, requestCode: Int): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java)
        if (href != null) {
            // its own action, so Android never treats it as "just bring the task to the front"
            intent.setAction(ACTION_OPEN_HREF).putExtra(EXTRA_HREF, href)
        } else {
            intent.setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(ctx, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun keepAlive(ctx: Context, title: String, text: String): Notification {
        ensureChannels(ctx)
        return NotificationCompat.Builder(ctx, CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_tether)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openApp(ctx, null, KEEP_ALIVE_ID))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    /** Replaces the keep-alive text without restarting the service (allowed from the background). */
    fun updateKeepAlive(ctx: Context, title: String, text: String) {
        if (!canPost(ctx)) return
        try {
            NotificationManagerCompat.from(ctx).notify(KEEP_ALIVE_ID, keepAlive(ctx, title, text))
        } catch (_: SecurityException) {
            // permission revoked between the check and the call
        }
    }

    /**
     * An agent notification, from a push or from the web app while it runs in the background.
     * Notifications with the same tag replace each other. False when notifications are off.
     */
    fun push(ctx: Context, title: String, body: String, href: String?, tag: String?): Boolean {
        if (!canPost(ctx)) return false
        ensureChannels(ctx)
        val id = if (tag != null) TAGGED_ID else nextId.incrementAndGet()
        val requestCode = tag?.hashCode() ?: id
        val notification = NotificationCompat.Builder(ctx, CHANNEL_AGENTS)
            .setSmallIcon(R.drawable.ic_stat_tether)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openApp(ctx, href, requestCode))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        return try {
            NotificationManagerCompat.from(ctx).notify(tag, id, notification)
            true
        } catch (_: SecurityException) {
            // permission revoked between the check and the call
            false
        }
    }

    /** Removes the agent notification with this tag, or every agent notification without one. */
    fun clear(ctx: Context, tag: String?) {
        val nm = NotificationManagerCompat.from(ctx)
        if (tag != null) return nm.cancel(tag, TAGGED_ID)
        val system = ctx.getSystemService(NotificationManager::class.java) ?: return
        for (n in system.activeNotifications) {
            if (n.id != KEEP_ALIVE_ID) nm.cancel(n.tag, n.id)
        }
    }
}
