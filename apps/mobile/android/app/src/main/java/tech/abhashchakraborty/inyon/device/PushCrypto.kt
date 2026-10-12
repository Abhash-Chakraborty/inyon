package tech.abhashchakraborty.inyon.device

import java.security.GeneralSecurityException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Opens the encrypted push payload: `12-byte IV || AES-256-GCM ciphertext || 16-byte tag`, no
 * associated data. WebCrypto's AES-GCM encrypt returns ciphertext||tag, which is exactly what
 * `Cipher.doFinal` expects, so the hub only prepends the IV.
 */
object PushCrypto {

    const val KEY_BYTES = 32
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    fun decrypt(key: ByteArray?, blob: ByteArray?): String {
        if (key == null || key.size != KEY_BYTES) throw GeneralSecurityException("push key must be 32 bytes")
        if (blob == null || blob.size < IV_BYTES + TAG_BITS / 8) throw GeneralSecurityException("push payload is too short")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, blob, 0, IV_BYTES))
        return String(cipher.doFinal(blob, IV_BYTES, blob.size - IV_BYTES), Charsets.UTF_8)
    }
}
