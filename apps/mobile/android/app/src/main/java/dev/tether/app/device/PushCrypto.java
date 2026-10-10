package dev.tether.app.device;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Opens the encrypted push payload: {@code 12-byte IV || AES-256-GCM ciphertext || 16-byte tag},
 * no associated data. WebCrypto's AES-GCM encrypt returns ciphertext||tag, which is exactly what
 * {@code Cipher.doFinal} expects, so the hub only prepends the IV.
 */
public final class PushCrypto {

    public static final int KEY_BYTES = 32;
    static final int IV_BYTES = 12;
    static final int TAG_BITS = 128;

    private PushCrypto() {}

    public static String decrypt(byte[] key, byte[] blob) throws GeneralSecurityException {
        if (key == null || key.length != KEY_BYTES) throw new GeneralSecurityException("push key must be 32 bytes");
        if (blob == null || blob.length < IV_BYTES + TAG_BITS / 8) throw new GeneralSecurityException("push payload is too short");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(TAG_BITS, blob, 0, IV_BYTES));
        byte[] plain = cipher.doFinal(blob, IV_BYTES, blob.length - IV_BYTES);
        return new String(plain, StandardCharsets.UTF_8);
    }
}
