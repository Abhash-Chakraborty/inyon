package dev.tether.app.device;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Reads a file handed over by the keyboard or the clipboard into {@code { name, type, data }}. */
final class ContentReader {

    static final int MAX_BYTES = 25 * 1024 * 1024;

    static final class TooLargeException extends IOException {

        TooLargeException() {
            super("The file is larger than 25 MB");
        }
    }

    private ContentReader() {}

    static JSObject read(Context ctx, Uri uri, String typeHint) throws IOException {
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) throw new IOException("unsupported uri: " + uri.getScheme());
        String authority = uri.getAuthority();
        // a clip pointing at one of our own providers would read our private files
        if (authority == null || authority.startsWith(ctx.getPackageName())) throw new IOException("unsupported uri");

        ContentResolver cr = ctx.getContentResolver();
        String type = cr.getType(uri);
        if ((type == null || type.equals("application/octet-stream")) && typeHint != null) type = typeHint;
        if (type == null) type = "application/octet-stream";

        String name = null;
        long size = -1;
        try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int s = c.getColumnIndex(OpenableColumns.SIZE);
                if (n >= 0 && !c.isNull(n)) name = c.getString(n);
                if (s >= 0 && !c.isNull(s)) size = c.getLong(s);
            }
        } catch (RuntimeException ignored) {
            // some keyboards' providers don't answer queries; the name and size are optional
        }
        if (size > MAX_BYTES) throw new TooLargeException();

        byte[] bytes;
        try (InputStream in = cr.openInputStream(uri)) {
            if (in == null) throw new IOException("could not open the file");
            bytes = readCapped(in);
        }

        if (name == null || name.isEmpty()) name = defaultName(type);
        JSObject ret = new JSObject();
        ret.put("name", name);
        ret.put("type", type);
        ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
        return ret;
    }

    private static byte[] readCapped(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int total = 0;
        for (int n; (n = in.read(buf)) != -1;) {
            total += n;
            if (total > MAX_BYTES) throw new TooLargeException();
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private static String defaultName(String type) {
        String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        String base = type.startsWith("image/") ? "image-" : "file-";
        return base + stamp + (ext != null ? "." + ext : "");
    }
}
