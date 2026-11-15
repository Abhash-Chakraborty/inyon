package tech.abhashchakraborty.inyon.device

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * Dictation into the message box with the phone's own speech recogniser, since the WebView has no
 * Web Speech API. Its guesses go to the web app as they come ("partial"), then the settled words
 * ("final") and "end"; the recogniser stops by itself once you've been quiet. Each run carries the
 * id the web app gave it, so the end of an old run can't end a new one. Main thread only, as
 * SpeechRecognizer requires.
 */
class Dictation(private val context: Context, private val emit: (id: String, kind: String, text: String?, error: String?) -> Unit) {

    private var recognizer: SpeechRecognizer? = null
    private var id = ""

    fun start(runId: String, lang: String?) {
        cancel()
        val r = SpeechRecognizer.createSpeechRecognizer(context)
        recognizer = r
        id = runId
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}

            override fun onBeginningOfSpeech() {}

            override fun onRmsChanged(rmsdB: Float) {}

            override fun onBufferReceived(buffer: ByteArray?) {}

            override fun onEndOfSpeech() {}

            override fun onEvent(eventType: Int, params: Bundle?) {}

            override fun onPartialResults(partialResults: Bundle?) {
                if (recognizer === r) emit(runId, "partial", best(partialResults), null)
            }

            override fun onResults(results: Bundle?) {
                if (recognizer !== r) return
                emit(runId, "final", best(results), null)
                end(r, runId)
            }

            override fun onError(error: Int) {
                // some recognisers report an error after their results: that run is over already
                if (recognizer !== r) return
                DictationErrors.name(error)?.let { emit(runId, "error", null, it) }
                end(r, runId)
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        if (!lang.isNullOrBlank()) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
        r.startListening(intent)
    }

    /** Finish: the words heard so far still come as "final". */
    fun stop() {
        recognizer?.stopListening()
    }

    /** Drop it: nothing more but "end". */
    fun cancel() {
        val r = recognizer ?: return
        r.cancel()
        end(r, id)
    }

    private fun end(r: SpeechRecognizer, runId: String) {
        if (recognizer === r) recognizer = null
        r.destroy()
        emit(runId, "end", null, null)
    }

    private fun best(results: Bundle?): String = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
}

/** SpeechRecognizer's error codes as the web app names them (lib/dictation.ts). */
object DictationErrors {
    fun name(code: Int): String? =
        when (code) {
            // ERROR_INSUFFICIENT_PERMISSIONS
            9 -> "NOT_ALLOWED"
            // ERROR_SPEECH_TIMEOUT, ERROR_NO_MATCH
            6, 7 -> "NO_SPEECH"
            // ERROR_NETWORK_TIMEOUT, ERROR_NETWORK, ERROR_SERVER, ERROR_SERVER_DISCONNECTED
            1, 2, 4, 11 -> "NETWORK"
            // ERROR_AUDIO (another app holds the microphone), ERROR_RECOGNIZER_BUSY, ERROR_TOO_MANY_REQUESTS
            3, 8, 10 -> "BUSY"
            // ERROR_LANGUAGE_NOT_SUPPORTED, ERROR_LANGUAGE_UNAVAILABLE
            12, 13 -> "UNAVAILABLE"
            // ERROR_CLIENT: the run was stopped or cancelled from here
            5 -> null
            else -> "OTHER"
        }
}
