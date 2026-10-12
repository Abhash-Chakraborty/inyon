package tech.abhashchakraborty.inyon.ssh

import android.content.SharedPreferences
import android.util.Base64
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import tech.abhashchakraborty.inyon.device.KeepAliveService
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import org.json.JSONObject

/** Direct SSH to the user's servers. All the SSH work lives in [SshCore]. */
@CapacitorPlugin(name = "InyonSsh")
class InyonSshPlugin : Plugin() {

    private val pool = Executors.newCachedThreadPool()

    // keystrokes for one PTY must reach the server in the order they were typed
    private val ptyQueues = ConcurrentHashMap<String, SerialExecutor>()
    private lateinit var core: SshCore
    private var secrets: SharedPreferences? = null

    override fun load() {
        core = SshCore(
            object : SshCore.Events {
                override fun streamLines(streamId: String, lines: List<String>) {
                    // in the background this is how alerts start: stay awake long enough to post one
                    KeepAliveService.nudge()
                    notifyListeners("streamLines", JSObject().put("streamId", streamId).put("lines", JSArray(lines)))
                }

                override fun streamExit(streamId: String, code: Int) {
                    KeepAliveService.nudge()
                    notifyListeners("streamExit", JSObject().put("streamId", streamId).put("code", code))
                }

                override fun ptyData(ptyId: String, data: ByteArray) {
                    notifyListeners("ptyData", JSObject().put("ptyId", ptyId).put("data", Base64.encodeToString(data, Base64.NO_WRAP)))
                }

                override fun ptyExit(ptyId: String, code: Int) {
                    ptyQueues.remove(ptyId)
                    notifyListeners("ptyExit", JSObject().put("ptyId", ptyId).put("code", code))
                }

                override fun closed(serverId: String, reason: String) {
                    KeepAliveService.nudge()
                    notifyListeners("closed", JSObject().put("id", serverId).put("reason", reason))
                }
            },
        )
        // the release smoke test looks for this line
        Log.i(TAG, "ready")
    }

    override fun handleOnDestroy() {
        if (::core.isInitialized) core.shutdown()
        pool.shutdown()
    }

    @PluginMethod
    fun probe(call: PluginCall) {
        val host = call.getString("host") ?: return call.reject("host is required", SshCore.BAD_REQUEST)
        val port = intArg(call, "port", 22)
        run(call) {
            val key = core.probe(host, port)
            call.resolve(JSObject().put("fingerprint", key.fingerprint).put("keyType", key.keyType))
        }
    }

    @PluginMethod
    fun connect(call: PluginCall) {
        val id = call.getString("id")
        val host = call.getString("host")
        val port = intArg(call, "port", 22)
        val hostKey = call.getString("hostKey")
        if (id == null || host == null) return call.reject("id and host are required", SshCore.BAD_REQUEST)
        val creds = SshCore.Credentials(
            username = call.getString("username"),
            password = call.getString("password"),
            privateKey = call.getString("privateKey"),
            passphrase = call.getString("passphrase"),
        )
        try {
            creds.ed25519Seed = base64Arg(call, "ed25519Seed")
            creds.ed25519Public = base64Arg(call, "ed25519Public")
        } catch (_: IllegalArgumentException) {
            return call.reject("ed25519Seed/ed25519Public must be base64", SshCore.BAD_REQUEST)
        }
        run(call) {
            core.connect(id, host, port, hostKey, creds)
            call.resolve(ok())
        }
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id is required", SshCore.BAD_REQUEST)
        run(call) {
            core.disconnect(id)
            call.resolve(ok())
        }
    }

    @PluginMethod
    fun exec(call: PluginCall) {
        val id = call.getString("id")
        val command = call.getString("command")
        val timeoutMs = longArg(call, "timeoutMs", SshCore.DEFAULT_EXEC_TIMEOUT_MS)
        if (id == null || command == null) return call.reject("id and command are required", SshCore.BAD_REQUEST)
        val stdin = try {
            base64Arg(call, "stdin")
        } catch (_: IllegalArgumentException) {
            return call.reject("stdin must be base64", SshCore.BAD_REQUEST)
        }
        run(call) {
            val r = core.exec(id, command, stdin, timeoutMs)
            call.resolve(JSObject().put("code", r.code).put("stdout", r.stdout).put("stderr", r.stderr))
        }
    }

    @PluginMethod
    fun stream(call: PluginCall) {
        val id = call.getString("id")
        val streamId = call.getString("streamId")
        val command = call.getString("command")
        val keepStdin = call.getBoolean("keepStdin", false) == true
        if (id == null || streamId == null || command == null) {
            return call.reject("id, streamId and command are required", SshCore.BAD_REQUEST)
        }
        run(call) {
            core.stream(id, streamId, command, keepStdin)
            call.resolve(ok())
        }
    }

    @PluginMethod
    fun streamKill(call: PluginCall) {
        val streamId = call.getString("streamId") ?: return call.reject("streamId is required", SshCore.BAD_REQUEST)
        run(call) {
            core.streamKill(streamId)
            call.resolve(ok())
        }
    }

    @PluginMethod
    fun pty(call: PluginCall) {
        val id = call.getString("id")
        val ptyId = call.getString("ptyId")
        val command = call.getString("command")
        val cols = intArg(call, "cols", 80)
        val rows = intArg(call, "rows", 24)
        if (id == null || ptyId == null) return call.reject("id and ptyId are required", SshCore.BAD_REQUEST)
        run(call) {
            core.pty(id, ptyId, command, cols, rows)
            call.resolve(ok())
        }
    }

    @PluginMethod
    fun ptyWrite(call: PluginCall) {
        val ptyId = call.getString("ptyId")
        val data = call.getString("data")
        if (ptyId == null || data == null) return call.reject("ptyId and data are required", SshCore.BAD_REQUEST)
        val bytes = data.toByteArray(Charsets.UTF_8)
        runInOrder(ptyId, call) {
            core.ptyWrite(ptyId, bytes)
            call.resolve(ok())
        }
    }

    @PluginMethod
    fun ptyResize(call: PluginCall) {
        val ptyId = call.getString("ptyId") ?: return call.reject("ptyId is required", SshCore.BAD_REQUEST)
        val cols = intArg(call, "cols", 80)
        val rows = intArg(call, "rows", 24)
        runInOrder(ptyId, call) {
            core.ptyResize(ptyId, cols, rows)
            call.resolve(ok())
        }
    }

    @PluginMethod
    fun ptyKill(call: PluginCall) {
        val ptyId = call.getString("ptyId") ?: return call.reject("ptyId is required", SshCore.BAD_REQUEST)
        run(call) {
            core.ptyKill(ptyId)
            call.resolve(ok())
        }
    }

    // ---- secrets ---------------------------------------------------------------------------

    @PluginMethod
    fun setSecret(call: PluginCall) {
        val key = call.getString("key")
        val value = call.getString("value")
        if (key == null || value == null) return call.reject("key and value are required", SshCore.BAD_REQUEST)
        run(call) {
            check(secrets().edit().putString(key, value).commit()) { "could not save the secret" }
            call.resolve(ok())
        }
    }

    @PluginMethod
    fun getSecret(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required", SshCore.BAD_REQUEST)
        run(call) {
            call.resolve(JSObject().put("value", secrets().getString(key, null) ?: JSONObject.NULL))
        }
    }

    @PluginMethod
    fun deleteSecret(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required", SshCore.BAD_REQUEST)
        run(call) {
            secrets().edit().remove(key).commit()
            call.resolve(ok())
        }
    }

    @Synchronized
    @Suppress("DEPRECATION")
    private fun secrets(): SharedPreferences =
        secrets ?: EncryptedSharedPreferences.create(
            context,
            SECRETS_FILE,
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        ).also { secrets = it }

    // ---- plumbing --------------------------------------------------------------------------

    private fun run(call: PluginCall, task: () -> Unit) {
        pool.execute { runNow(call, task) }
    }

    private fun runInOrder(key: String, call: PluginCall, task: () -> Unit) {
        ptyQueues.getOrPut(key) { SerialExecutor(pool) }.execute { runNow(call, task) }
    }

    /** Runs tasks one at a time, in submission order, on a shared executor. */
    private class SerialExecutor(private val executor: Executor) : Executor {
        private val tasks = ArrayDeque<Runnable>()
        private var active: Runnable? = null

        @Synchronized
        override fun execute(r: Runnable) {
            tasks.offer(
                Runnable {
                    try {
                        r.run()
                    } finally {
                        scheduleNext()
                    }
                },
            )
            if (active == null) scheduleNext()
        }

        @Synchronized
        private fun scheduleNext() {
            active = tasks.poll()
            active?.let(executor::execute)
        }
    }

    private companion object {
        const val TAG = "InyonSsh"
        const val SECRETS_FILE = "inyon_secrets"

        fun runNow(call: PluginCall, task: () -> Unit) {
            try {
                task()
            } catch (e: SshCore.SshException) {
                call.reject(e.message, e.code)
            } catch (e: Exception) {
                call.reject(e.message ?: e.toString(), SshCore.ERROR, e)
            }
        }

        fun ok(): JSObject = JSObject().put("ok", true)

        fun intArg(call: PluginCall, name: String, fallback: Int) = (call.data.opt(name) as? Number)?.toInt() ?: fallback

        fun longArg(call: PluginCall, name: String, fallback: Long) = (call.data.opt(name) as? Number)?.toLong() ?: fallback

        fun base64Arg(call: PluginCall, name: String): ByteArray? = call.getString(name)?.let { Base64.decode(it, Base64.DEFAULT) }
    }
}
