package dev.tether.app.ssh;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Splits a byte stream into UTF-8 lines on '\n', dropping a trailing '\r'. Splitting happens on
 * bytes, so a multi-byte character cut across two reads still decodes correctly.
 */
final class LineSplitter {

    private static final int SMALL = 256;

    private byte[] carry = new byte[SMALL];
    private int carryLen;

    List<String> feed(byte[] b, int off, int len) {
        List<String> out = null;
        int start = off;
        int end = off + len;
        for (int i = off; i < end; i++) {
            if (b[i] != '\n') continue;
            String line;
            if (carryLen == 0) {
                line = decode(b, start, i - start);
            } else {
                append(b, start, i - start);
                line = decode(carry, 0, carryLen);
                resetCarry();
            }
            if (out == null) out = new ArrayList<>();
            out.add(line);
            start = i + 1;
        }
        if (start < end) append(b, start, end - start);
        return out == null ? Collections.<String>emptyList() : out;
    }

    /** The unterminated last line, or null when there is none. */
    String finish() {
        if (carryLen == 0) return null;
        String line = decode(carry, 0, carryLen);
        resetCarry();
        return line;
    }

    private void append(byte[] b, int off, int len) {
        if (len == 0) return;
        if (carryLen + len > carry.length) {
            byte[] next = new byte[Math.max(carry.length * 2, carryLen + len)];
            System.arraycopy(carry, 0, next, 0, carryLen);
            carry = next;
        }
        System.arraycopy(b, off, carry, carryLen, len);
        carryLen += len;
    }

    private void resetCarry() {
        carryLen = 0;
        // don't keep a multi-MB buffer around after one huge line
        if (carry.length > 1 << 20) carry = new byte[SMALL];
    }

    private static String decode(byte[] b, int off, int len) {
        if (len > 0 && b[off + len - 1] == '\r') len--;
        return new String(b, off, len, StandardCharsets.UTF_8);
    }
}
