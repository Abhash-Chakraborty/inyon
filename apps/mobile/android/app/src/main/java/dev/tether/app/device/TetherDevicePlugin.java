package dev.tether.app.device;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import androidx.core.view.inputmethod.InputConnectionCompat;
import androidx.core.view.inputmethod.InputContentInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.common.moduleinstall.ModuleInstall;
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.mlkit.common.MlKitException;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Phone-only features: keyboard/clipboard files, background keep-alive, push and QR scanning. */
@CapacitorPlugin(
    name = "TetherDevice",
    permissions = { @Permission(alias = TetherDevicePlugin.NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class TetherDevicePlugin extends Plugin {

    static final String NOTIFICATIONS = "notifications";
    private static final String TAG = "TetherDevice";

    // the services outlive the activity, so they reach the web app through whichever instance is live
    private static volatile TetherDevicePlugin live;

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private volatile String launchHref;
    private Integer savedRendererPriority;
    private boolean savedRendererWaived;

    @Override
    public void load() {
        live = this;
        Notifications.ensureChannels(getContext());
        WebView webView = getBridge().getWebView();
        if (webView instanceof TetherWebView tether) tether.setContentListener(this::onKeyboardContent);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        String href = intent.getStringExtra(Notifications.EXTRA_HREF);
        if (href == null) return;
        intent.removeExtra(Notifications.EXTRA_HREF);
        // the activity is exported, so any app could send this: only in-app paths get through
        if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/\\")) return;
        if (hasListeners("pushOpened")) {
            JSObject data = new JSObject();
            data.put("href", href);
            notifyListeners("pushOpened", data);
        } else {
            // cold start: the web app isn't listening yet and asks with takeLaunchHref()
            launchHref = href;
        }
    }

    @Override
    protected void handleOnStop() {
        // Capacitor only pauses the WebView when KeepRunning is false (it isn't here), but undo any
        // pause anyway while the user asked to stay connected
        if (KeepAliveService.isRunning()) {
            WebView webView = getBridge().getWebView();
            webView.onResume();
            webView.resumeTimers();
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (live == this) live = null;
        if (getBridge().getWebView() instanceof TetherWebView tether) tether.setContentListener(null);
        // the WebView goes with the activity, so there is nothing left to keep alive
        if (KeepAliveService.isRunning()) getContext().stopService(new Intent(getContext(), KeepAliveService.class));
        pool.shutdown();
    }

    // ---- files from the keyboard and the clipboard -----------------------------------------

    private boolean onKeyboardContent(InputContentInfoCompat content, int flags) {
        if (!hasListeners("pasteFile")) return false;
        boolean granted = false;
        if (Build.VERSION.SDK_INT >= 25 && (flags & InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) {
            try {
                content.requestPermission();
                granted = true;
            } catch (Exception e) {
                Log.w(TAG, "keyboard content permission refused: " + e);
                return false;
            }
        }
        final boolean release = granted;
        ClipDescription description = content.getDescription();
        final String typeHint = description.getMimeTypeCount() > 0 ? description.getMimeType(0) : null;
        final Uri uri = content.getContentUri();
        pool.execute(() -> {
            try {
                notifyListeners("pasteFile", ContentReader.read(getContext(), uri, typeHint));
            } catch (Exception e) {
                pasteError(e);
            } finally {
                if (release) content.releasePermission();
            }
        });
        return true;
    }

    private void pasteError(Exception e) {
        Log.w(TAG, "could not read pasted content: " + e);
        JSObject data = new JSObject();
        data.put("message", e instanceof ContentReader.TooLargeException ? e.getMessage() : "Couldn't read the pasted file");
        notifyListeners("pasteError", data);
    }

    @PluginMethod
    public void readClipboardFile(final PluginCall call) {
        pool.execute(() -> {
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = cm != null ? cm.getPrimaryClip() : null;
                if (clip != null) {
                    ClipDescription d = clip.getDescription();
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        Uri uri = clip.getItemAt(i).getUri();
                        if (uri == null) continue;
                        String hint = null;
                        for (int j = 0; d != null && j < d.getMimeTypeCount(); j++) {
                            String t = d.getMimeType(j);
                            if (!t.startsWith("text/") && !t.contains("*")) {
                                hint = t;
                                break;
                            }
                        }
                        call.resolve(ContentReader.read(getContext(), uri, hint));
                        return;
                    }
                }
                call.resolve(new JSObject());
            } catch (ContentReader.TooLargeException e) {
                call.reject(e.getMessage(), "TOO_LARGE");
            } catch (Exception e) {
                call.reject("Couldn't read the clipboard: " + e.getMessage(), "ERROR");
            }
        });
    }

    // ---- staying connected in the background -----------------------------------------------

    @PluginMethod
    public void startKeepAlive(final PluginCall call) {
        Context ctx = getContext();
        try {
            ContextCompat.startForegroundService(ctx, KeepAliveService.intent(ctx, call.getString("title"), call.getString("text")));
        } catch (IllegalStateException e) {
            // Android 12+ refuses to start a foreground service while the app is in the background
            call.reject("Can't start the background connection right now: " + e.getMessage(), "NOT_ALLOWED");
            return;
        }
        getBridge().executeOnMainThread(() -> rendererImportant(true));
        call.resolve(ok());
    }

    @PluginMethod
    public void updateKeepAlive(final PluginCall call) {
        if (KeepAliveService.isRunning()) {
            String title = call.getString("title", "Tether");
            String text = call.getString("text", "Connected");
            Notifications.updateKeepAlive(getContext(), title, text);
        }
        call.resolve(ok());
    }

    @PluginMethod
    public void stopKeepAlive(final PluginCall call) {
        getContext().stopService(new Intent(getContext(), KeepAliveService.class));
        getBridge().executeOnMainThread(() -> rendererImportant(false));
        call.resolve(ok());
    }

    static void keepAliveEnded(String reason) {
        TetherDevicePlugin p = live;
        if (p == null) return;
        p.getBridge().executeOnMainThread(() -> p.rendererImportant(false));
        JSObject data = new JSObject();
        data.put("reason", reason);
        p.notifyListeners("keepAliveStopped", data);
    }

    /** Keeps the renderer process as important as the app while hidden; restores the old policy after. */
    private void rendererImportant(boolean on) {
        if (Build.VERSION.SDK_INT < 26) return;
        WebView webView = getBridge().getWebView();
        if (on) {
            if (savedRendererPriority == null) {
                savedRendererPriority = webView.getRendererRequestedPriority();
                savedRendererWaived = webView.getRendererPriorityWaivedWhenNotVisible();
            }
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        } else if (savedRendererPriority != null) {
            webView.setRendererPriorityPolicy(savedRendererPriority, savedRendererWaived);
            savedRendererPriority = null;
        }
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(final PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject ret = new JSObject();
        ret.put("ignoring", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(ret);
    }

    /** The system list where the user can exempt Tether; the app details page where that list is missing. */
    @PluginMethod
    public void openBatterySettings(final PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            try {
                getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (ActivityNotFoundException e) {
                try {
                    Intent details = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
                    getActivity().startActivity(details);
                } catch (ActivityNotFoundException e2) {
                    call.reject("No battery settings screen on this device", "UNAVAILABLE");
                    return;
                }
            }
            call.resolve(ok());
        });
    }

    // ---- notifications and push ------------------------------------------------------------

    @PluginMethod
    public void notificationsEnabled(final PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", Notifications.canPost(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void requestNotificationPermission(final PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            notificationPermissionResult(call);
        } else {
            requestPermissionForAlias(NOTIFICATIONS, call, "notificationPermissionResult");
        }
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", Notifications.canPost(getContext()));
        call.resolve(ret);
    }

    // registration tokens are what the hub sends to; the installation-ID registration that
    // firebase-messaging 25.1 deprecates them for is opt-in and needs a different send path
    @PluginMethod
    @SuppressWarnings("deprecation")
    public void pushToken(final PluginCall call) {
        final FirebaseMessaging messaging;
        try {
            if (!Push.init(getContext())) {
                call.resolve(error("Push isn't set up in this build"));
                return;
            }
            messaging = FirebaseMessaging.getInstance();
            // auto-init is off in the manifest so unconfigured builds stay quiet; once the web app
            // asks for a token, let the SDK keep it fresh
            messaging.setAutoInitEnabled(true);
        } catch (RuntimeException e) {
            call.resolve(error("Push isn't available: " + e.getMessage()));
            return;
        }
        messaging
            .getToken()
            .addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) {
                    JSObject ret = new JSObject();
                    ret.put("token", task.getResult());
                    call.resolve(ret);
                } else {
                    Exception e = task.getException();
                    call.resolve(error(e != null && e.getMessage() != null ? e.getMessage() : "Couldn't get a push token"));
                }
            });
    }

    static void emitToken(String token) {
        TetherDevicePlugin p = live;
        if (p == null) return;
        JSObject data = new JSObject();
        data.put("token", token);
        p.notifyListeners("pushToken", data);
    }

    /** The AES-256-GCM key the hub encrypts pushes with; null or empty clears it. */
    @PluginMethod
    public void setPushKey(final PluginCall call) {
        final String key = call.getString("key");
        final byte[] bytes;
        if (key == null || key.isEmpty()) {
            bytes = null;
        } else {
            try {
                bytes = Push.base64(key);
            } catch (IllegalArgumentException e) {
                call.reject("key must be base64", "BAD_REQUEST");
                return;
            }
            if (bytes.length != PushCrypto.KEY_BYTES) {
                call.reject("key must be 32 bytes", "BAD_REQUEST");
                return;
            }
        }
        pool.execute(() -> {
            try {
                Push.saveKey(getContext(), bytes);
                call.resolve(ok());
            } catch (Exception e) {
                call.reject("Couldn't save the push key: " + e.getMessage(), "ERROR");
            }
        });
    }

    @PluginMethod
    public void takeLaunchHref(final PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("href", launchHref != null ? launchHref : JSONObject.NULL);
        launchHref = null;
        call.resolve(ret);
    }

    // ---- QR codes --------------------------------------------------------------------------

    @PluginMethod
    public void scanQr(final PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build();
            final GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getActivity(), options);
            scanner
                .startScan()
                .addOnSuccessListener(barcode -> {
                    String text = barcode.getRawValue();
                    if (text == null && barcode.getRawBytes() != null) text = new String(barcode.getRawBytes(), StandardCharsets.UTF_8);
                    JSObject ret = new JSObject();
                    ret.put("text", text != null ? text : "");
                    call.resolve(ret);
                })
                .addOnCanceledListener(() -> call.resolve(cancelled()))
                .addOnFailureListener(e -> {
                    int code = e instanceof MlKitException mk ? mk.getErrorCode() : -1;
                    if (code == MlKitException.CODE_SCANNER_CANCELLED || code == MlKitException.CANCELLED) {
                        call.resolve(cancelled());
                    } else if (code == MlKitException.CODE_SCANNER_UNAVAILABLE || code == MlKitException.UNAVAILABLE) {
                        installScanner(scanner);
                        call.reject("The QR scanner is still being downloaded by Google Play services. Try again in a minute.", "SCANNER_UNAVAILABLE");
                    } else {
                        call.reject(e.getMessage() != null ? e.getMessage() : "QR scanning failed", "ERROR");
                    }
                });
        });
    }

    private void installScanner(GmsBarcodeScanner scanner) {
        ModuleInstall.getClient(getContext())
            .installModules(ModuleInstallRequest.newBuilder().addApi(scanner).build())
            .addOnFailureListener(e -> Log.w(TAG, "could not request the scanner module: " + e));
    }

    // ---- plumbing --------------------------------------------------------------------------

    private static JSObject ok() {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        return ret;
    }

    private static JSObject error(String message) {
        JSObject ret = new JSObject();
        ret.put("error", message);
        return ret;
    }

    private static JSObject cancelled() {
        JSObject ret = new JSObject();
        ret.put("cancelled", true);
        return ret;
    }
}
