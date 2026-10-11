package dev.tether.app.device;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationChannelCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import dev.tether.app.MainActivity;
import dev.tether.app.R;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Notification channels and everything the app posts. Every notification carries the Tether mark
 * (the status-bar glyph, and the full logo inside); each session has one notification that the
 * next event replaces, grouped under a summary once there are several.
 */
final class Notifications {

    static final String ACTION_OPEN_HREF = "dev.tether.app.action.OPEN_HREF";
    static final String EXTRA_HREF = "dev.tether.app.extra.HREF";
    static final String CHANNEL_CONNECTION = "connection";
    /** an agent asking something: heads-up, it's waiting on you */
    static final String CHANNEL_ATTENTION = "attention";
    /** an agent that finished */
    static final String CHANNEL_AGENTS = "agents";
    static final String CHANNEL_MACHINES = "machines";
    static final int KEEP_ALIVE_ID = 7001;

    private static final int EVENT_ID = 7002;
    private static final int SUMMARY_ID = 7003;
    private static final String GROUP = "dev.tether.app.EVENTS";
    private static Bitmap logo;
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
            new NotificationChannelCompat.Builder(CHANNEL_ATTENTION, NotificationManagerCompat.IMPORTANCE_HIGH)
                .setName("Needs you")
                .setDescription("An agent is asking something or waiting for approval")
                .build()
        );
        nm.createNotificationChannel(
            new NotificationChannelCompat.Builder(CHANNEL_AGENTS, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName("Finished")
                .setDescription("An agent finished its turn")
                .build()
        );
        nm.createNotificationChannel(
            new NotificationChannelCompat.Builder(CHANNEL_MACHINES, NotificationManagerCompat.IMPORTANCE_LOW)
                .setName("Machines")
                .setDescription("A server or laptop went offline or came back")
                .build()
        );
    }

    /** The app's logo, drawn once at notification size. */
    private static synchronized Bitmap logo(Context ctx) {
        if (logo != null) return logo;
        try {
            Drawable d = ContextCompat.getDrawable(ctx, R.mipmap.ic_launcher_round);
            if (d == null) return null;
            int px = Math.round(64 * ctx.getResources().getDisplayMetrics().density);
            Bitmap b = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888);
            d.setBounds(0, 0, px, px);
            d.draw(new Canvas(b));
            logo = b;
        } catch (RuntimeException ignored) {
            // no logo is better than no notification
        }
        return logo;
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

    /**
     * An agent or machine event. `tag` names the session (or machine): its next event replaces
     * this one. `kind` is waiting, done, offline or online and picks the channel.
     */
    static void post(Context ctx, String title, String body, String href, String tag, String kind) {
        if (!canPost(ctx)) return;
        ensureChannels(ctx);
        String channel = "waiting".equals(kind) ? CHANNEL_ATTENTION
            : "offline".equals(kind) || "online".equals(kind) ? CHANNEL_MACHINES
            : CHANNEL_AGENTS;
        int id = tag != null ? EVENT_ID : nextId.incrementAndGet();
        int requestCode = tag != null ? tag.hashCode() : id;
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat_tether)
            .setLargeIcon(logo(ctx))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openApp(ctx, href, requestCode))
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setAutoCancel(true)
            .setGroup(GROUP)
            .setPriority("waiting".equals(kind) ? NotificationCompat.PRIORITY_HIGH : "offline".equals(kind) || "online".equals(kind) ? NotificationCompat.PRIORITY_LOW : NotificationCompat.PRIORITY_DEFAULT)
            .setCategory("waiting".equals(kind) ? NotificationCompat.CATEGORY_REMINDER : NotificationCompat.CATEGORY_STATUS);
        try {
            NotificationManagerCompat.from(ctx).notify(tag, id, b.build());
        } catch (SecurityException ignored) {
            // permission revoked between the check and the call
        }
        summarize(ctx);
    }

    /** Takes a session's notification away (you opened it). */
    static void clear(Context ctx, String tag) {
        NotificationManagerCompat.from(ctx).cancel(tag, EVENT_ID);
        summarize(ctx);
    }

    /** One summary over two or more events, listing them; none for a single one. */
    private static void summarize(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        List<StatusBarNotification> events = new ArrayList<>();
        for (StatusBarNotification n : nm.getActiveNotifications()) {
            if (GROUP.equals(n.getNotification().getGroup()) && n.getId() != SUMMARY_ID) events.add(n);
        }
        if (events.size() < 2) {
            nm.cancel(SUMMARY_ID);
            return;
        }
        NotificationCompat.InboxStyle inbox = new NotificationCompat.InboxStyle();
        for (StatusBarNotification n : events) {
            CharSequence t = n.getNotification().extras.getCharSequence(Notification.EXTRA_TITLE);
            CharSequence x = n.getNotification().extras.getCharSequence(Notification.EXTRA_TEXT);
            inbox.addLine(t + (x != null && x.length() > 0 ? " · " + x : ""));
        }
        String count = events.size() + " sessions";
        inbox.setSummaryText(count);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_AGENTS)
            .setSmallIcon(R.drawable.ic_stat_tether)
            .setLargeIcon(logo(ctx))
            .setContentTitle("Tether")
            .setContentText(count)
            .setStyle(inbox)
            .setContentIntent(openApp(ctx, "/", SUMMARY_ID))
            .setGroup(GROUP)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setAutoCancel(true);
        try {
            NotificationManagerCompat.from(ctx).notify(SUMMARY_ID, b.build());
        } catch (SecurityException ignored) {
            // permission revoked between the check and the call
        }
    }
}
