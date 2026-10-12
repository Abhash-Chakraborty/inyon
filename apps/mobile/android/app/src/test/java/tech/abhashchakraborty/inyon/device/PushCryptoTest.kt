package tech.abhashchakraborty.inyon.device

import java.security.GeneralSecurityException
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * The vector comes from Bun's WebCrypto, the same code path the hub uses:
 *
 * ```
 * const key = new Uint8Array(32).map((_, i) => i)
 * const iv = new Uint8Array(12).map((_, i) => 0xa0 + i)
 * const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
 * const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(plain)))
 * const p = Buffer.concat([iv, ct]).toString('base64')   // ct already ends with the 16-byte tag
 * ```
 *
 * In production the IV must be fresh random bytes for every message.
 */
class PushCryptoTest {

    @Test
    fun decryptsWebCryptoOutput() {
        assertEquals(PLAIN, PushCrypto.decrypt(b64(KEY), b64(P)))
    }

    @Test
    fun rejectsTamperedCiphertext() {
        val blob = b64(P)
        blob[20] = (blob[20].toInt() xor 1).toByte()
        expectFailure(b64(KEY), blob)
    }

    @Test
    fun rejectsTamperedIv() {
        val blob = b64(P)
        blob[0] = (blob[0].toInt() xor 1).toByte()
        expectFailure(b64(KEY), blob)
    }

    @Test
    fun rejectsWrongKey() {
        val key = b64(KEY)
        key[31] = (key[31].toInt() xor 1).toByte()
        expectFailure(key, b64(P))
    }

    @Test
    fun rejectsBadLengths() {
        expectFailure(ByteArray(16), b64(P))
        expectFailure(b64(KEY), ByteArray(27))
        expectFailure(b64(KEY), null)
    }

    private companion object {
        const val KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
        const val PLAIN =
            "{\"title\":\"claude finished\",\"body\":\"tests pass on inyon-api — ready for review\",\"href\":\"/s/abc123\",\"tag\":\"abc123\"}"
        const val P =
            "oKGio6SlpqeoqaqrnToIRDGnZ51YR+S/Zg+ku1DKMH77xCoJ+CwKpB3EEXjwTGWLylEnTn/sZbt6WuyXZ28jPAq1aFMgLmJ+RvARkMbZ5AtJhYKPhsKNffmnqc3vJ4nMt6T/WNRXEeme+y/3vrYYiS+M+/r5+Txy5OqOGRZjQ9MaduDPZlrSIbLhlURYfX+I"

        fun b64(s: String): ByteArray = Base64.getDecoder().decode(s)

        fun expectFailure(key: ByteArray?, blob: ByteArray?) {
            assertThrows(GeneralSecurityException::class.java) { PushCrypto.decrypt(key, blob) }
        }
    }
}
