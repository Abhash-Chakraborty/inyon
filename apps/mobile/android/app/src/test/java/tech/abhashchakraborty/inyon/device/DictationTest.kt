package tech.abhashchakraborty.inyon.device

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Dictation in the message box: what the web app is told, and what Android is asked for. */
class DictationTest {
    private val device = File("src/main/java/tech/abhashchakraborty/inyon/device")

    @Test
    fun recogniserErrorsAreNamedAsTheWebAppReadsThem() {
        assertEquals("NOT_ALLOWED", DictationErrors.name(9))
        assertEquals("NO_SPEECH", DictationErrors.name(7))
        assertEquals("NO_SPEECH", DictationErrors.name(6))
        assertEquals("NETWORK", DictationErrors.name(2))
        assertEquals("BUSY", DictationErrors.name(8))
        assertEquals("UNAVAILABLE", DictationErrors.name(12))
        assertEquals("OTHER", DictationErrors.name(99))
        // stopped or cancelled from here: not a failure to show
        assertNull(DictationErrors.name(5))
    }

    @Test
    fun theWebAppKnowsEveryName() {
        val web = File("../../../web/src/lib/dictation.ts").readText()
        for (code in (1..15)) {
            val name = DictationErrors.name(code) ?: continue
            if (name != "OTHER") assertTrue("dictation.ts doesn't read $name", web.contains("'$name'"))
        }
    }

    @Test
    fun theMicrophoneIsDeclaredAndAskedForAtFirstUse() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("""<uses-permission android:name="android.permission.RECORD_AUDIO" />"""))
        // without it Android 11 and later hide the speech recogniser from the app
        assertTrue(manifest.contains("""<action android:name="android.speech.RecognitionService" />"""))
        val plugin = File(device, "InyonDevicePlugin.kt").readText()
        assertTrue(plugin.contains("Permission(alias = InyonDevicePlugin.MICROPHONE, strings = [Manifest.permission.RECORD_AUDIO])"))
        assertTrue(plugin.substringAfter("fun startDictation(call: PluginCall)").substringBefore("@PermissionCallback").contains("requestPermissionForAlias(MICROPHONE"))
    }

    @Test
    fun listeningEndsWhenTheAppGoesOffScreen() {
        val plugin = File(device, "InyonDevicePlugin.kt").readText()
        val stop = plugin.substringAfter("override fun handleOnStop()").substringBefore("override fun")
        assertTrue(stop, stop.contains("dictation?.stop()"))
        val destroy = plugin.substringAfter("override fun handleOnDestroy()").substringBefore("@PluginMethod")
        assertTrue(destroy, destroy.contains("dictation?.cancel()"))
    }
}
