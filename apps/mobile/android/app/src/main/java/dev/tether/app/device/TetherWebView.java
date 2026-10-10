package dev.tether.app.device;

import android.content.Context;
import android.text.InputType;
import android.util.AttributeSet;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import androidx.core.view.inputmethod.EditorInfoCompat;
import androidx.core.view.inputmethod.InputConnectionCompat;
import androidx.core.view.inputmethod.InputContentInfoCompat;
import com.getcapacitor.CapacitorWebView;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Capacitor's WebView, plus rich content from the keyboard (images, GIFs, stickers, files).
 * Chromium's own input connection doesn't advertise any content types, so keyboards refuse to
 * insert them. Swapped in through res/layout/capacitor_bridge_layout_main.xml.
 */
public class TetherWebView extends CapacitorWebView {

    /** Called on the IME thread; return true when the content was taken. */
    public interface ContentListener {
        boolean onContent(InputContentInfoCompat content, int flags);
    }

    private static final String[] MIME_TYPES = {
        "image/*",
        "image/png",
        "image/gif",
        "image/jpeg",
        "image/webp",
        "image/heic",
        "video/*",
        "video/mp4",
        "application/pdf",
    };

    private volatile ContentListener contentListener;

    public TetherWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public void setContentListener(ContentListener listener) {
        contentListener = listener;
    }

    @Override
    @SuppressWarnings("deprecation") // the View-based wrapper routes through performReceiveContent on the IME thread
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection ic = super.onCreateInputConnection(outAttrs);
        final ContentListener listener = contentListener;
        if (ic == null || listener == null || isPassword(outAttrs.inputType)) return ic;
        Set<String> types = new LinkedHashSet<>();
        for (String t : EditorInfoCompat.getContentMimeTypes(outAttrs)) types.add(t);
        for (String t : MIME_TYPES) types.add(t);
        EditorInfoCompat.setContentMimeTypes(outAttrs, types.toArray(new String[0]));
        return InputConnectionCompat.createWrapper(ic, outAttrs, (content, flags, opts) -> listener.onContent(content, flags));
    }

    private static boolean isPassword(int inputType) {
        int cls = inputType & InputType.TYPE_MASK_CLASS;
        int variation = inputType & InputType.TYPE_MASK_VARIATION;
        if (cls == InputType.TYPE_CLASS_NUMBER) return variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD;
        return (
            cls == InputType.TYPE_CLASS_TEXT &&
            (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)
        );
    }
}
