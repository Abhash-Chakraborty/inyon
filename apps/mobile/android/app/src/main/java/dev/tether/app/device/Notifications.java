package dev.tether.app.device;

import android.Manifest;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationChannelCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import dev.tether.app.MainActivity;
import dev.tether.app.R;
import java.util.concurrent.atomic.AtomicInteger;

/** Notification channels and the two kinds of notification the app posts itself. */
final class Notifications {

    static final String ACTION_OPEN_HREF = "dev.tether.app.action.OPEN_HREF";
    static final String EXTRA_HREF = "dev.tether.app.extra.HREF";
    static final String CHANNEL_CONNECTION = "connection";
    static final String CHANNEL_AGENTS = "agents";
    static final int KEEP_ALIVE_ID = 7001;

    private static final int ACCENT = 0xFFD97757;
    private static final int PUSH_TAGGED_ID = 7002;
    private static final AtomicInteger nextId = new AtomicInteger((int) (System.currentTimeMillis() / 1000 % 1_000_000) + 10_000);

    private Notifications() {}

    static void ensureChannels(Context ctx) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        nm.createNotificationChannel(
            new NotificationChannelCompat.Builder(CHANNEL_CONNECTION, NotificationManagerCompat.IMPORTANCE_LOW)
                .setName("Connection")
                .setDescription("Shown while Tether stays connected in the background")
                .setShowBadge(false)
                .build()
        );
        nm.createNotificationChannel(
            new NotificationChannelCompat.Builder(CHANNEL_AGENTS, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName("Agents")
                .setDescription("Agents that finished or need your input")
                .build()
        );
    }

    static boolean canPost(Context ctx) {
        if (
            Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false;
        }
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled();
    }

    /** Opens (or brings back) the app; with an href, the plugin hands it to the web app. */
    static PendingIntent openApp(Context ctx, String href, int requestCode) {
        Intent intent = new Intent(ctx, MainActivity.class);
        if (href != null) {
            // its own action, so Android never treats it as "just bring the task to the front"
            intent.setAction(ACTION_OPEN_HREF).putExtra(EXTRA_HREF, href);
        } else {
            intent.setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static Notification keepAlive(Context ctx, String title, String text) {
        ensureChannels(ctx);
        return new NotificationCompat.Builder(ctx, CHANNEL_CONNECTION)
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
            .build();
    }

    /** Replaces the keep-alive text without restarting the service (allowed from the background). */
    static void updateKeepAlive(Context ctx, String title, String text) {
        if (!canPost(ctx)) return;
        try {
            NotificationManagerCompat.from(ctx).notify(KEEP_ALIVE_ID, keepAlive(ctx, title, text));
        } catch (SecurityException ignored) {
            // permission revoked between the check and the call
        }
    }

    /** A push from the hub. Notifications with the same tag replace each other. */
    static void push(Context ctx, String title, String body, String href, String tag) {
        if (!canPost(ctx)) return;
        ensureChannels(ctx);
        int id = tag != null ? PUSH_TAGGED_ID : nextId.incrementAndGet();
        int requestCode = tag != null ? tag.hashCode() : id;
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_AGENTS)
            .setSmallIcon(R.drawable.ic_stat_tether)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openApp(ctx, href, requestCode))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE);
        try {
            NotificationManagerCompat.from(ctx).notify(tag, id, b.build());
        } catch (SecurityException ignored) {
            // permission revoked between the check and the call
        }
    }
}
