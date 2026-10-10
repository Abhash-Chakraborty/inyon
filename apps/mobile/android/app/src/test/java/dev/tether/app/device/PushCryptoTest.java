package dev.tether.app.device;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import java.security.GeneralSecurityException;
import java.util.Base64;
import org.junit.Test;

/**
 * The vector comes from Bun's WebCrypto, the same code path the hub uses:
 *
 * <pre>
 * const key = new Uint8Array(32).map((_, i) => i)
 * const iv = new Uint8Array(12).map((_, i) => 0xa0 + i)
 * const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
 * const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(plain)))
 * const p = Buffer.concat([iv, ct]).toString('base64')   // ct already ends with the 16-byte tag
 * </pre>
 *
 * In production the IV must be fresh random bytes for every message.
 */
public class PushCryptoTest {

    private static final String KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    private static final String PLAIN =
        "{\"title\":\"claude finished\",\"body\":\"tests pass on tether-api — ready for review\",\"href\":\"/s/abc123\",\"tag\":\"abc123\"}";
    private static final String P =
        "oKGio6SlpqeoqaqrnToIRDGnZ51YR+S/Zg+ku1DKMH77xCoJ+CwKpB3EEXjwTGWLylEnTn/sZbt6WuyXZ28jPAq1aFMgLmJ+RvARkMbZ5AtJhYKPhsKNffmnqc3vJ4nMt6T/WNRXEeme+y/3vrYYiS+M+/r5+Txy5OqOGRZjQ9MaduDPZlrSIbLhlURYfX+I";

    private static byte[] b64(String s) {
        return Base64.getDecoder().decode(s);
    }

    @Test
    public void decryptsWebCryptoOutput() throws Exception {
        assertEquals(PLAIN, PushCrypto.decrypt(b64(KEY), b64(P)));
    }

    @Test
    public void rejectsTamperedCiphertext() {
        byte[] blob = b64(P);
        blob[20] ^= 1;
        expectFailure(b64(KEY), blob);
    }

    @Test
    public void rejectsTamperedIv() {
        byte[] blob = b64(P);
        blob[0] ^= 1;
        expectFailure(b64(KEY), blob);
    }

    @Test
    public void rejectsWrongKey() {
        byte[] key = b64(KEY);
        key[31] ^= 1;
        expectFailure(key, b64(P));
    }

    @Test
    public void rejectsBadLengths() {
        expectFailure(new byte[16], b64(P));
        expectFailure(b64(KEY), new byte[27]);
        expectFailure(b64(KEY), null);
    }

    private static void expectFailure(byte[] key, byte[] blob) {
        try {
            PushCrypto.decrypt(key, blob);
            fail("expected a GeneralSecurityException");
        } catch (GeneralSecurityException expected) {
            // ok
        }
    }
}
