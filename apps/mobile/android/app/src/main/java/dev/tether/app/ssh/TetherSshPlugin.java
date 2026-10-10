package dev.tether.app.ssh;

import android.content.SharedPreferences;
import android.util.Base64;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Direct SSH to the user's servers. All the SSH work lives in {@link SshCore}. */
@CapacitorPlugin(name = "TetherSsh")
public class TetherSshPlugin extends Plugin {

    private static final String SECRETS_FILE = "tether_secrets";

    private final ExecutorService pool = Executors.newCachedThreadPool();
    // keystrokes for one PTY must reach the server in the order they were typed
    private final ConcurrentHashMap<String, SerialExecutor> ptyQueues = new ConcurrentHashMap<>();
    private SshCore core;
    private SharedPreferences secrets;

    @Override
    public void load() {
        core = new SshCore(
            new SshCore.Events() {
                @Override
                public void streamLines(String streamId, List<String> lines) {
                    JSObject data = new JSObject();
                    data.put("streamId", streamId);
                    data.put("lines", new JSArray(lines));
                    notifyListeners("streamLines", data);
                }

                @Override
                public void streamExit(String streamId, int code) {
                    JSObject data = new JSObject();
                    data.put("streamId", streamId);
                    data.put("code", code);
                    notifyListeners("streamExit", data);
                }

                @Override
                public void ptyData(String ptyId, byte[] bytes) {
                    JSObject data = new JSObject();
                    data.put("ptyId", ptyId);
                    data.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    notifyListeners("ptyData", data);
                }

                @Override
                public void ptyExit(String ptyId, int code) {
                    ptyQueues.remove(ptyId);
                    JSObject data = new JSObject();
                    data.put("ptyId", ptyId);
                    data.put("code", code);
                    notifyListeners("ptyExit", data);
                }

                @Override
                public void closed(String serverId, String reason) {
                    JSObject data = new JSObject();
                    data.put("id", serverId);
                    data.put("reason", reason);
                    notifyListeners("closed", data);
                }
            }
        );
    }

    @Override
    protected void handleOnDestroy() {
        if (core != null) core.shutdown();
        pool.shutdown();
    }

    @PluginMethod
    public void probe(final PluginCall call) {
        final String host = call.getString("host");
        final int port = intArg(call, "port", 22);
        if (host == null) {
            call.reject("host is required", SshCore.BAD_REQUEST);
            return;
        }
        run(call, () -> {
            SshCore.HostKey key = core.probe(host, port);
            JSObject ret = new JSObject();
            ret.put("fingerprint", key.fingerprint);
            ret.put("keyType", key.keyType);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void connect(final PluginCall call) {
        final String id = call.getString("id");
        final String host = call.getString("host");
        final int port = intArg(call, "port", 22);
        final String hostKey = call.getString("hostKey");
        if (id == null || host == null) {
            call.reject("id and host are required", SshCore.BAD_REQUEST);
            return;
        }
        final SshCore.Credentials creds = new SshCore.Credentials();
        creds.username = call.getString("username");
        creds.password = call.getString("password");
        creds.privateKey = call.getString("privateKey");
        creds.passphrase = call.getString("passphrase");
        try {
            creds.ed25519Seed = base64Arg(call, "ed25519Seed");
            creds.ed25519Public = base64Arg(call, "ed25519Public");
        } catch (IllegalArgumentException e) {
            call.reject("ed25519Seed/ed25519Public must be base64", SshCore.BAD_REQUEST);
            return;
        }
        run(call, () -> {
            core.connect(id, host, port, hostKey, creds);
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void disconnect(final PluginCall call) {
        final String id = call.getString("id");
        if (id == null) {
            call.reject("id is required", SshCore.BAD_REQUEST);
            return;
        }
        run(call, () -> {
            core.disconnect(id);
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void exec(final PluginCall call) {
        final String id = call.getString("id");
        final String command = call.getString("command");
        final long timeoutMs = longArg(call, "timeoutMs", SshCore.DEFAULT_EXEC_TIMEOUT_MS);
        if (id == null || command == null) {
            call.reject("id and command are required", SshCore.BAD_REQUEST);
            return;
        }
        final byte[] stdin;
        try {
            stdin = base64Arg(call, "stdin");
        } catch (IllegalArgumentException e) {
            call.reject("stdin must be base64", SshCore.BAD_REQUEST);
            return;
        }
        run(call, () -> {
            SshCore.ExecResult r = core.exec(id, command, stdin, timeoutMs);
            JSObject ret = new JSObject();
            ret.put("code", r.code);
            ret.put("stdout", r.stdout);
            ret.put("stderr", r.stderr);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void stream(final PluginCall call) {
        final String id = call.getString("id");
        final String streamId = call.getString("streamId");
        final String command = call.getString("command");
        final boolean keepStdin = Boolean.TRUE.equals(call.getBoolean("keepStdin", false));
        if (id == null || streamId == null || command == null) {
            call.reject("id, streamId and command are required", SshCore.BAD_REQUEST);
            return;
        }
        run(call, () -> {
            core.stream(id, streamId, command, keepStdin);
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void streamKill(final PluginCall call) {
        final String streamId = call.getString("streamId");
        if (streamId == null) {
            call.reject("streamId is required", SshCore.BAD_REQUEST);
            return;
        }
        run(call, () -> {
            core.streamKill(streamId);
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void pty(final PluginCall call) {
        final String id = call.getString("id");
        final String ptyId = call.getString("ptyId");
        final String command = call.getString("command");
        final int cols = intArg(call, "cols", 80);
        final int rows = intArg(call, "rows", 24);
        if (id == null || ptyId == null) {
            call.reject("id and ptyId are required", SshCore.BAD_REQUEST);
            return;
        }
        run(call, () -> {
            core.pty(id, ptyId, command, cols, rows);
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void ptyWrite(final PluginCall call) {
        final String ptyId = call.getString("ptyId");
        final String data = call.getString("data");
        if (ptyId == null || data == null) {
            call.reject("ptyId and data are required", SshCore.BAD_REQUEST);
            return;
        }
        final byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
        runInOrder(ptyId, call, () -> {
            core.ptyWrite(ptyId, bytes);
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void ptyResize(final PluginCall call) {
        final String ptyId = call.getString("ptyId");
        final int cols = intArg(call, "cols", 80);
        final int rows = intArg(call, "rows", 24);
        if (ptyId == null) {
            call.reject("ptyId is required", SshCore.BAD_REQUEST);
            return;
        }
        runInOrder(ptyId, call, () -> {
            core.ptyResize(ptyId, cols, rows);
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void ptyKill(final PluginCall call) {
        final String ptyId = call.getString("ptyId");
        if (ptyId == null) {
            call.reject("ptyId is required", SshCore.BAD_REQUEST);
            return;
        }
        run(call, () -> {
            core.ptyKill(ptyId);
            call.resolve(ok());
        });
    }

    // ---- secrets ---------------------------------------------------------------------------

    @PluginMethod
    public void setSecret(final PluginCall call) {
        final String key = call.getString("key");
        final String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("key and value are required", SshCore.BAD_REQUEST);
            return;
        }
        run(call, () -> {
            if (!secrets().edit().putString(key, value).commit()) throw new IllegalStateException("could not save the secret");
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void getSecret(final PluginCall call) {
        final String key = call.getString("key");
        if (key == null) {
            call.reject("key is required", SshCore.BAD_REQUEST);
            return;
        }
        run(call, () -> {
            String value = secrets().getString(key, null);
            JSObject ret = new JSObject();
            ret.put("value", value == null ? JSONObject.NULL : value);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void deleteSecret(final PluginCall call) {
        final String key = call.getString("key");
        if (key == null) {
            call.reject("key is required", SshCore.BAD_REQUEST);
            return;
        }
        run(call, () -> {
            secrets().edit().remove(key).commit();
            call.resolve(ok());
        });
    }

    @SuppressWarnings("deprecation")
    private synchronized SharedPreferences secrets() throws Exception {
        if (secrets == null) {
            MasterKey masterKey = new MasterKey.Builder(getContext()).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
            secrets = EncryptedSharedPreferences.create(
                getContext(),
                SECRETS_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
        }
        return secrets;
    }

    // ---- plumbing --------------------------------------------------------------------------

    private interface Task {
        void run() throws Exception;
    }

    private void run(PluginCall call, Task task) {
        pool.execute(() -> runNow(call, task));
    }

    private void runInOrder(String key, PluginCall call, Task task) {
        SerialExecutor queue = ptyQueues.get(key);
        if (queue == null) {
            SerialExecutor fresh = new SerialExecutor(pool);
            queue = ptyQueues.putIfAbsent(key, fresh);
            if (queue == null) queue = fresh;
        }
        queue.execute(() -> runNow(call, task));
    }

    private static void runNow(PluginCall call, Task task) {
        try {
            task.run();
        } catch (SshCore.SshException e) {
            call.reject(e.getMessage(), e.code);
        } catch (Exception e) {
            String message = e.getMessage();
            call.reject(message != null ? message : e.toString(), SshCore.ERROR, e);
        }
    }

    private static JSObject ok() {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        return ret;
    }

    private static int intArg(PluginCall call, String name, int fallback) {
        Object v = call.getData().opt(name);
        return v instanceof Number ? ((Number) v).intValue() : fallback;
    }

    private static long longArg(PluginCall call, String name, long fallback) {
        Object v = call.getData().opt(name);
        return v instanceof Number ? ((Number) v).longValue() : fallback;
    }

    private static byte[] base64Arg(PluginCall call, String name) {
        String v = call.getString(name);
        return v == null ? null : Base64.decode(v, Base64.DEFAULT);
    }

    /** Runs tasks one at a time, in submission order, on a shared executor. */
    private static final class SerialExecutor implements Executor {

        private final ArrayDeque<Runnable> tasks = new ArrayDeque<>();
        private final Executor executor;
        private Runnable active;

        SerialExecutor(Executor executor) {
            this.executor = executor;
        }

        @Override
        public synchronized void execute(final Runnable r) {
            tasks.offer(() -> {
                try {
                    r.run();
                } finally {
                    scheduleNext();
                }
            });
            if (active == null) scheduleNext();
        }

        private synchronized void scheduleNext() {
            if ((active = tasks.poll()) != null) executor.execute(active);
        }
    }
}
