package dev.tether.app.ssh;

import com.trilead.ssh2.ChannelCondition;
import com.trilead.ssh2.Connection;
import com.trilead.ssh2.ConnectionMonitor;
import com.trilead.ssh2.InteractiveCallback;
import com.trilead.ssh2.ProxyData;
import com.trilead.ssh2.ServerHostKeyVerifier;
import com.trilead.ssh2.Session;
import com.trilead.ssh2.crypto.PEMDecoder;
import com.trilead.ssh2.crypto.fingerprint.KeyFingerprint;
import com.trilead.ssh2.crypto.keys.Ed25519PrivateKey;
import com.trilead.ssh2.crypto.keys.Ed25519PublicKey;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * SSH for the phone app: run a command, stream a command's stdout line by line, and run a PTY,
 * on servers identified by ids chosen by the caller. Plain Java (no Android imports) so it can be
 * tested on a JVM against a real sshd.
 *
 * One logical server may use several SSH connections: OpenSSH caps sessions per connection
 * (MaxSessions, 10 by default), so when no existing connection can open another session a new one
 * is made with the same credentials, up to {@link #MAX_LINKS}.
 */
public final class SshCore {

    public interface Events {
        void streamLines(String streamId, List<String> lines);

        void streamExit(String streamId, int code);

        void ptyData(String ptyId, byte[] data);

        void ptyExit(String ptyId, int code);

        void closed(String serverId, String reason);
    }

    public static final String HOST_KEY_MISMATCH = "HOST_KEY_MISMATCH";
    public static final String AUTH_FAILED = "AUTH_FAILED";
    public static final String UNREACHABLE = "UNREACHABLE";
    public static final String NOT_CONNECTED = "NOT_CONNECTED";
    public static final String NOT_FOUND = "NOT_FOUND";
    public static final String BAD_REQUEST = "BAD_REQUEST";
    public static final String ERROR = "ERROR";

    public static final class SshException extends Exception {

        public final String code;

        public SshException(String code, String message) {
            super(message);
            this.code = code;
        }

        public SshException(String code, String message, Throwable cause) {
            super(message, cause);
            this.code = code;
        }
    }

    /** What to authenticate with. Tried in field order: ed25519 seed, private key text, password. */
    public static final class Credentials {

        public String username;
        public String password;
        public String privateKey;
        public String passphrase;
        public byte[] ed25519Seed;
        public byte[] ed25519Public;

        boolean sameAs(Credentials o) {
            return eq(username, o.username)
                && eq(password, o.password)
                && eq(privateKey, o.privateKey)
                && eq(passphrase, o.passphrase)
                && Arrays.equals(ed25519Seed, o.ed25519Seed)
                && Arrays.equals(ed25519Public, o.ed25519Public);
        }

        private static boolean eq(String a, String b) {
            return a == null ? b == null : a.equals(b);
        }
    }

    public static final class HostKey {

        public final String fingerprint;
        public final String keyType;

        HostKey(String fingerprint, String keyType) {
            this.fingerprint = fingerprint;
            this.keyType = keyType;
        }
    }

    public static final class ExecResult {

        public final int code;
        public final String stdout;
        public final String stderr;

        ExecResult(int code, String stdout, String stderr) {
            this.code = code;
            this.stdout = stdout;
            this.stderr = stderr;
        }
    }

    public static final long DEFAULT_EXEC_TIMEOUT_MS = 20000;
    static final int CONNECT_TIMEOUT_MS = 12000;
    static final int AUTH_TIMEOUT_MS = 30000;
    static final long KEEPALIVE_MS = 15000;
    static final int MAX_LINKS = 6;
    static final long FLUSH_MS = 30;
    static final int FLUSH_LINES = 1000;
    static final long IDLE_LINK_MS = 60000;
    static final long EXIT_STATUS_WAIT_MS = 5000;
    static final long CLOSE_GRACE_MS = 3000;

    private final Events events;
    private final ExecutorService pool = Executors.newCachedThreadPool(daemon("tether-ssh"));
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(daemon("tether-ssh-timer"));
    private final ConcurrentHashMap<String, Server> servers = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Object> locks = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, StreamJob> streams = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, PtyJob> ptys = new ConcurrentHashMap<>();

    public SshCore(Events events) {
        this.events = events;
        timer.scheduleWithFixedDelay(this::tick, KEEPALIVE_MS, KEEPALIVE_MS, TimeUnit.MILLISECONDS);
    }

    // ---- public API ------------------------------------------------------------------------

    public HostKey probe(String host, int port) throws SshException {
        final AtomicReference<HostKey> seen = new AtomicReference<>();
        Connection conn = new Connection(host, port);
        conn.setProxyData(new SocketOpener());
        try {
            // refusing the key ends the handshake right after the server has shown it
            conn.connect(
                (hostname, p, algorithm, key) -> {
                    seen.set(new HostKey(fingerprint(key), keyType(key, algorithm)));
                    return false;
                },
                CONNECT_TIMEOUT_MS,
                CONNECT_TIMEOUT_MS
            );
        } catch (IOException e) {
            if (seen.get() == null) throw unreachable(host, port, e);
        } finally {
            conn.close();
        }
        HostKey key = seen.get();
        if (key == null) throw new SshException(UNREACHABLE, "no host key received from " + host + ":" + port);
        return key;
    }

    public void connect(String id, String host, int port, String hostKey, Credentials creds) throws SshException {
        if (hostKey == null || hostKey.trim().isEmpty()) throw new SshException(BAD_REQUEST, "hostKey is required");
        if (creds == null || creds.username == null || creds.username.isEmpty()) {
            throw new SshException(BAD_REQUEST, "username is required");
        }
        String expected = normalizeFingerprint(hostKey);
        synchronized (lockFor(id)) {
            Server existing = servers.get(id);
            if (existing != null) {
                if (existing.same(host, port, expected, creds) && existing.hasLiveLink()) return;
                disconnect(id);
            }
            Server server = new Server(id, host, port, expected, creds);
            Link link = openLink(server);
            synchronized (server) {
                server.links.add(link);
            }
            if (link.lost) {
                closeLink(link);
                throw new SshException(UNREACHABLE, "connection to " + host + ":" + port + " dropped right after login");
            }
            servers.put(id, server);
        }
    }

    public void disconnect(String id) {
        synchronized (lockFor(id)) {
            Server server = servers.remove(id);
            if (server == null) return;
            server.closing = true;
            List<Link> links;
            synchronized (server) {
                links = new ArrayList<>(server.links);
                server.links.clear();
            }
            for (Link link : links) closeLink(link);
        }
    }

    public ExecResult exec(String id, String command, final byte[] stdin, long timeoutMs) throws SshException {
        if (command == null) throw new SshException(BAD_REQUEST, "command is required");
        long timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_EXEC_TIMEOUT_MS;
        long deadline = System.currentTimeMillis() + timeout;
        final Opened opened = openSessionBefore(id, deadline);
        if (opened == null) return new ExecResult(124, "", "timed out");
        final Session session = opened.session;
        final ByteArrayOutputStream out = new ByteArrayOutputStream();
        final ByteArrayOutputStream err = new ByteArrayOutputStream();
        Future<?> outDone;
        Future<?> errDone;
        try {
            session.execCommand(command);
            outDone = pool.submit(() -> drain(session.getStdout(), out));
            errDone = pool.submit(() -> drain(session.getStderr(), err));
            pool.execute(() -> {
                // closing stdin sends EOF, so commands that read it don't wait forever
                try (OutputStream in = session.getStdin()) {
                    if (stdin != null && stdin.length > 0) in.write(stdin);
                } catch (IOException ignored) {
                }
            });
        } catch (IOException | RuntimeException e) {
            opened.release();
            throw new SshException(ERROR, "exec failed: " + describe(e), e);
        }

        boolean timedOut = !await(outDone, deadline) || !await(errDone, deadline);
        Integer status = null;
        if (!timedOut) {
            long left = Math.max(1, deadline - System.currentTimeMillis());
            int cond = session.waitForCondition(
                ChannelCondition.EXIT_STATUS | ChannelCondition.EXIT_SIGNAL | ChannelCondition.CLOSED,
                left
            );
            status = session.getExitStatus();
            if (status == null && (cond & (ChannelCondition.EXIT_SIGNAL | ChannelCondition.CLOSED)) == 0) timedOut = true;
        }
        opened.release();
        if (timedOut) {
            // closing the channel ends both readers; give them a moment to hand over what arrived
            awaitQuietly(outDone, 2000);
            awaitQuietly(errDone, 2000);
            return new ExecResult(124, utf8(out), utf8(err) + "timed out");
        }
        return new ExecResult(status != null ? status : 255, utf8(out), utf8(err));
    }

    public void stream(String id, String streamId, String command, boolean keepStdin) throws SshException {
        if (streamId == null || command == null) throw new SshException(BAD_REQUEST, "streamId and command are required");
        if (streams.containsKey(streamId)) throw new SshException(BAD_REQUEST, "stream " + streamId + " already exists");
        final Opened opened = openSession(id);
        final StreamJob job = new StreamJob(streamId, opened);
        if (streams.putIfAbsent(streamId, job) != null) {
            opened.release();
            throw new SshException(BAD_REQUEST, "stream " + streamId + " already exists");
        }
        try {
            opened.session.execCommand(command);
            // tmux control mode exits when stdin closes, so keepStdin leaves it open and unused
            if (!keepStdin) opened.session.getStdin().close();
            pool.execute(() -> drain(opened.session.getStderr(), null));
            pool.execute(job::run);
        } catch (IOException | RuntimeException e) {
            streams.remove(streamId, job);
            opened.release();
            throw new SshException(ERROR, "stream failed: " + describe(e), e);
        }
    }

    public void streamKill(String streamId) {
        StreamJob job = streams.get(streamId);
        if (job == null) return;
        job.killed = true;
        job.opened.session.close();
    }

    public void pty(String id, String ptyId, String command, int cols, int rows) throws SshException {
        if (ptyId == null) throw new SshException(BAD_REQUEST, "ptyId is required");
        if (ptys.containsKey(ptyId)) throw new SshException(BAD_REQUEST, "pty " + ptyId + " already exists");
        final Opened opened = openSession(id);
        final PtyJob job = new PtyJob(ptyId, opened);
        if (ptys.putIfAbsent(ptyId, job) != null) {
            opened.release();
            throw new SshException(BAD_REQUEST, "pty " + ptyId + " already exists");
        }
        try {
            opened.session.requestPTY("xterm-256color", Math.max(1, cols), Math.max(1, rows), 0, 0, null);
            if (command == null || command.isEmpty()) opened.session.startShell();
            else opened.session.execCommand(command);
            pool.execute(() -> job.pump(opened.session.getStdout()));
            pool.execute(() -> job.pump(opened.session.getStderr()));
        } catch (IOException | RuntimeException e) {
            ptys.remove(ptyId, job);
            opened.release();
            throw new SshException(ERROR, "pty failed: " + describe(e), e);
        }
    }

    public void ptyWrite(String ptyId, byte[] data) throws SshException {
        PtyJob job = pty(ptyId);
        try {
            synchronized (job) {
                OutputStream in = job.opened.session.getStdin();
                in.write(data);
                in.flush();
            }
        } catch (IOException e) {
            throw new SshException(ERROR, "pty write failed: " + describe(e), e);
        }
    }

    public void ptyResize(String ptyId, int cols, int rows) throws SshException {
        PtyJob job = pty(ptyId);
        try {
            job.opened.session.resizePTY(Math.max(1, cols), Math.max(1, rows), 0, 0);
        } catch (IOException e) {
            throw new SshException(ERROR, "pty resize failed: " + describe(e), e);
        }
    }

    public void ptyKill(String ptyId) {
        PtyJob job = ptys.get(ptyId);
        if (job == null) return;
        job.killed = true;
        job.opened.session.close();
    }

    /** Closes every server. The instance can't be used afterwards. */
    public void shutdown() {
        for (String id : new ArrayList<>(servers.keySet())) disconnect(id);
        timer.shutdown();
        pool.shutdown();
    }

    // ---- connections -----------------------------------------------------------------------

    private static final class Server {

        final String id;
        final String host;
        final int port;
        final String hostKey;
        final Credentials creds;
        final List<Link> links = new ArrayList<>(); // guarded by this
        final Object growLock = new Object();
        volatile boolean closing;

        Server(String id, String host, int port, String hostKey, Credentials creds) {
            this.id = id;
            this.host = host;
            this.port = port;
            this.hostKey = hostKey;
            this.creds = creds;
        }

        boolean same(String host, int port, String hostKey, Credentials creds) {
            return this.host.equals(host) && this.port == port && this.hostKey.equals(hostKey) && this.creds.sameAs(creds);
        }

        synchronized boolean hasLiveLink() {
            for (Link l : links) if (!l.lost && !l.closing) return true;
            return false;
        }
    }

    /** One SSH connection belonging to a server. */
    private final class Link implements ConnectionMonitor {

        final Server server;
        final Connection conn;
        final SocketOpener opener;
        final AtomicInteger sessions = new AtomicInteger();
        volatile boolean ready;
        volatile boolean lost;
        volatile boolean closing;
        volatile long lastUsed = System.currentTimeMillis();
        volatile long pingStarted;
        volatile String dropReason;

        Link(Server server, Connection conn, SocketOpener opener) {
            this.server = server;
            this.conn = conn;
            this.opener = opener;
        }

        @Override
        public void connectionLost(Throwable reason) {
            lost = true;
            if (ready && !closing) onLinkLost(this, reason);
        }
    }

    /** Opens the TCP socket itself so a hung connection can be torn down without the library's locks. */
    private static final class SocketOpener implements ProxyData {

        private volatile Socket socket;
        private volatile boolean killed;

        @Override
        public Socket openConnection(String hostname, int port, int connectTimeout) throws IOException {
            Socket s = new Socket();
            socket = s;
            if (killed) s.close();
            s.setTcpNoDelay(true);
            s.setKeepAlive(true);
            s.connect(new InetSocketAddress(hostname, port), connectTimeout);
            return s;
        }

        void kill() {
            killed = true;
            Socket s = socket;
            if (s == null) return;
            try {
                s.close();
            } catch (IOException ignored) {
            }
        }
    }

    private static final class HostKeyCheck implements ServerHostKeyVerifier {

        final String expected;
        volatile String presented;

        HostKeyCheck(String expected) {
            this.expected = expected;
        }

        @Override
        public boolean verifyServerHostKey(String hostname, int port, String algorithm, byte[] key) {
            String fp = fingerprint(key);
            if (fp.equals(expected)) return true;
            presented = fp;
            return false;
        }
    }

    private Link openLink(Server server) throws SshException {
        Connection conn = new Connection(server.host, server.port);
        SocketOpener opener = new SocketOpener();
        conn.setProxyData(opener);
        Link link = new Link(server, conn, opener);
        conn.addConnectionMonitor(link);
        HostKeyCheck check = new HostKeyCheck(server.hostKey);
        // the library has no timeout for authentication, so bound the whole login
        ScheduledFuture<?> guard = timer.schedule(opener::kill, AUTH_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        boolean ok = false;
        try {
            try {
                conn.connect(check, CONNECT_TIMEOUT_MS, CONNECT_TIMEOUT_MS);
            } catch (IOException e) {
                if (check.presented != null) {
                    throw new SshException(
                        HOST_KEY_MISMATCH,
                        "host key mismatch for " + server.host + ": expected " + server.hostKey + ", server presented " + check.presented
                    );
                }
                throw unreachable(server.host, server.port, e);
            }
            authenticate(link, server.creds);
            link.ready = true;
            ok = true;
            return link;
        } finally {
            guard.cancel(false);
            if (!ok) {
                link.closing = true;
                conn.close();
            }
        }
    }

    private interface Attempt {
        boolean run() throws IOException;
    }

    private void authenticate(Link link, Credentials c) throws SshException {
        final Connection conn = link.conn;
        final String user = c.username;
        String[] lastError = new String[1];

        if (c.ed25519Seed != null && c.ed25519Public != null) {
            if (c.ed25519Seed.length != 32 || c.ed25519Public.length != 32) {
                throw new SshException(BAD_REQUEST, "ed25519Seed and ed25519Public must be 32 bytes each");
            }
            final KeyPair pair = new KeyPair(
                new Ed25519PublicKey(c.ed25519Public.clone()),
                new Ed25519PrivateKey(c.ed25519Seed.clone())
            );
            if (attempt(link, user, "publickey", () -> conn.authenticateWithPublicKey(user, pair), lastError)) return;
        }

        if (c.privateKey != null && !c.privateKey.isEmpty()) {
            KeyPair decoded = null;
            try {
                decoded = PEMDecoder.decode(c.privateKey.toCharArray(), emptyToNull(c.passphrase));
            } catch (IOException | RuntimeException e) {
                lastError[0] = "private key could not be read (wrong passphrase or unsupported format): " + describe(e);
            }
            final KeyPair pair = decoded;
            if (pair != null && attempt(link, user, "publickey", () -> conn.authenticateWithPublicKey(user, pair), lastError)) return;
        }

        final String password = c.password;
        if (password != null) {
            if (attempt(link, user, "password", () -> conn.authenticateWithPassword(user, password), lastError)) return;
            InteractiveCallback answer = new InteractiveCallback() {
                private int rounds;

                @Override
                public String[] replyToChallenge(String name, String instruction, int numPrompts, String[] prompt, boolean[] echo)
                    throws Exception {
                    // only plain password prompts can be answered; give up on anything that keeps asking
                    if (numPrompts > 0 && ++rounds > 2) throw new IOException("unexpected keyboard-interactive prompts");
                    String[] replies = new String[numPrompts];
                    Arrays.fill(replies, password);
                    return replies;
                }
            };
            if (attempt(link, user, "keyboard-interactive", () -> conn.authenticateWithKeyboardInteractive(user, answer), lastError)) {
                return;
            }
        }

        if (lastError[0] != null) throw new SshException(AUTH_FAILED, "authentication failed: " + lastError[0]);
        String methods;
        try {
            methods = Arrays.toString(conn.getRemainingAuthMethods(user));
        } catch (IOException | RuntimeException e) {
            methods = "unknown";
        }
        throw new SshException(AUTH_FAILED, "authentication failed for " + user + " (server accepts " + methods + ")");
    }

    private boolean attempt(Link link, String user, String method, Attempt a, String[] lastError) throws SshException {
        try {
            if (!link.conn.isAuthMethodAvailable(user, method)) return false;
            return a.run();
        } catch (IOException | RuntimeException e) {
            if (link.lost) {
                throw new SshException(UNREACHABLE, "connection lost during authentication: " + describe(e), e);
            }
            lastError[0] = method + ": " + describe(e);
            return false;
        }
    }

    private void onLinkLost(Link link, Throwable reason) {
        Server server = link.server;
        boolean empty;
        synchronized (server) {
            server.links.remove(link);
            empty = server.links.isEmpty();
        }
        // streams and PTYs on this link see EOF without an exit status and report 255 themselves
        if (empty && !server.closing && servers.remove(server.id, server)) {
            String why = link.dropReason != null ? link.dropReason : reason == null ? "connection lost" : describe(reason);
            events.closed(server.id, why);
        }
    }

    private void closeLink(Link link) {
        link.closing = true;
        ScheduledFuture<?> guard = null;
        try {
            guard = timer.schedule(link.opener::kill, CLOSE_GRACE_MS, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            link.opener.kill();
        }
        try {
            link.conn.close();
        } catch (RuntimeException ignored) {
        } finally {
            if (guard != null) guard.cancel(false);
        }
    }

    /** Keepalive, dead connection detection and closing extra connections nobody uses. */
    private void tick() {
        try {
            long now = System.currentTimeMillis();
            for (Server server : servers.values()) {
                List<Link> links;
                synchronized (server) {
                    links = new ArrayList<>(server.links);
                }
                for (int i = 0; i < links.size(); i++) {
                    final Link link = links.get(i);
                    if (link.lost || link.closing) continue;
                    if (i > 0 && link.sessions.get() == 0 && now - link.lastUsed > IDLE_LINK_MS) {
                        boolean reap;
                        synchronized (server) {
                            reap = link.sessions.get() == 0 && server.links.remove(link);
                            if (reap) link.closing = true;
                        }
                        if (reap) pool.execute(() -> closeLink(link));
                        continue;
                    }
                    long started = link.pingStarted;
                    if (started != 0) {
                        // the previous ping never came back: drop the socket so everything waiting wakes up
                        if (now - started >= KEEPALIVE_MS) {
                            link.dropReason = "no reply to keepalive";
                            link.opener.kill();
                        }
                        continue;
                    }
                    link.pingStarted = now;
                    pool.execute(() -> {
                        try {
                            link.conn.ping();
                            link.pingStarted = 0;
                        } catch (Exception e) {
                            if (link.dropReason == null && !link.lost) link.dropReason = "keepalive failed: " + describe(e);
                            link.opener.kill();
                        }
                    });
                }
            }
        } catch (RuntimeException ignored) {
            // a failing tick must not cancel the schedule
        }
    }

    // ---- sessions --------------------------------------------------------------------------

    private static final class Opened {

        final Link link;
        final Session session;
        private final AtomicBoolean released = new AtomicBoolean();

        Opened(Link link, Session session) {
            this.link = link;
            this.session = session;
        }

        void release() {
            if (!released.compareAndSet(false, true)) return;
            session.close();
            link.sessions.decrementAndGet();
            link.lastUsed = System.currentTimeMillis();
        }
    }

    private Opened openSession(String id) throws SshException {
        Server server = servers.get(id);
        if (server == null) throw new SshException(NOT_CONNECTED, "not connected: " + id);
        Opened opened = tryLinks(server);
        if (opened != null) return opened;
        synchronized (server.growLock) {
            opened = tryLinks(server);
            if (opened != null) return opened;
            if (server.closing || servers.get(id) != server) throw new SshException(NOT_CONNECTED, "not connected: " + id);
            int count;
            synchronized (server) {
                count = server.links.size();
            }
            if (count >= MAX_LINKS) {
                throw new SshException(ERROR, "no free SSH session on " + id + " (" + count + " connections, all full)");
            }
            Link link = openLink(server);
            synchronized (server) {
                server.links.add(link);
            }
            if (link.lost || server.closing || servers.get(id) != server) {
                synchronized (server) {
                    server.links.remove(link);
                }
                closeLink(link);
                throw new SshException(NOT_CONNECTED, "not connected: " + id);
            }
            try {
                return open(link);
            } catch (IOException | RuntimeException e) {
                throw new SshException(ERROR, "could not open an SSH session on " + id + ": " + describe(e), e);
            }
        }
    }

    /**
     * Opening a session blocks without a timeout on a connection that died silently (until the
     * keepalive notices), so exec waits for it only until its own deadline. Null when that passed.
     */
    private Opened openSessionBefore(final String id, long deadline) throws SshException {
        if (!servers.containsKey(id)) throw new SshException(NOT_CONNECTED, "not connected: " + id);
        final Future<Opened> pending = pool.submit(() -> openSession(id));
        try {
            return pending.get(Math.max(1, deadline - System.currentTimeMillis()), TimeUnit.MILLISECONDS);
        } catch (TimeoutException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            pool.execute(() -> {
                try {
                    pending.get().release();
                } catch (Exception ignored) {
                }
            });
            return null;
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof SshException) throw (SshException) cause;
            throw new SshException(ERROR, "could not open an SSH session on " + id + ": " + describe(cause), cause);
        }
    }

    /** Tries the least busy connections first; a refusal usually means that one is at MaxSessions. */
    private Opened tryLinks(Server server) {
        List<Link> links;
        synchronized (server) {
            links = new ArrayList<>(server.links);
        }
        Collections.sort(links, new Comparator<Link>() {
            @Override
            public int compare(Link a, Link b) {
                return a.sessions.get() - b.sessions.get();
            }
        });
        for (Link link : links) {
            if (link.lost || link.closing) continue;
            try {
                return open(link);
            } catch (IOException | RuntimeException ignored) {
            }
        }
        return null;
    }

    private static Opened open(Link link) throws IOException {
        link.sessions.incrementAndGet();
        try {
            Session session = link.conn.openSession();
            link.lastUsed = System.currentTimeMillis();
            return new Opened(link, session);
        } catch (IOException | RuntimeException e) {
            link.sessions.decrementAndGet();
            throw e;
        }
    }

    private static int exitCode(Session session, StreamOrPty job) {
        if (!job.killed()) {
            session.waitForCondition(
                ChannelCondition.EXIT_STATUS | ChannelCondition.EXIT_SIGNAL | ChannelCondition.CLOSED,
                EXIT_STATUS_WAIT_MS
            );
        }
        if (job.killed()) return 143;
        Integer status = session.getExitStatus();
        return status != null ? status : 255;
    }

    private interface StreamOrPty {
        boolean killed();
    }

    private final class StreamJob implements StreamOrPty {

        final String id;
        final Opened opened;
        volatile boolean killed;
        private final LineSplitter splitter = new LineSplitter();
        private final List<String> pending = new ArrayList<>(); // guarded by this
        private boolean flushScheduled;
        private boolean finished;

        StreamJob(String id, Opened opened) {
            this.id = id;
            this.opened = opened;
        }

        @Override
        public boolean killed() {
            return killed;
        }

        void run() {
            byte[] buf = new byte[16384];
            InputStream in = opened.session.getStdout();
            try {
                int n;
                while ((n = in.read(buf)) > 0) {
                    List<String> lines = splitter.feed(buf, 0, n);
                    if (!lines.isEmpty()) add(lines);
                }
            } catch (IOException ignored) {
            }
            String tail = splitter.finish();
            synchronized (this) {
                if (tail != null) pending.add(tail);
                flushLocked();
                finished = true;
            }
            int code = exitCode(opened.session, this);
            opened.release();
            streams.remove(id, this);
            events.streamExit(id, code);
        }

        private synchronized void add(List<String> lines) {
            pending.addAll(lines);
            if (pending.size() >= FLUSH_LINES) {
                flushLocked();
                return;
            }
            if (flushScheduled) return;
            flushScheduled = true;
            try {
                timer.schedule(this::flush, FLUSH_MS, TimeUnit.MILLISECONDS);
            } catch (RejectedExecutionException e) {
                flushScheduled = false;
                flushLocked();
            }
        }

        synchronized void flush() {
            flushScheduled = false;
            if (!finished) flushLocked();
        }

        private void flushLocked() {
            if (pending.isEmpty()) return;
            List<String> batch = new ArrayList<>(pending);
            pending.clear();
            events.streamLines(id, batch);
        }
    }

    private final class PtyJob implements StreamOrPty {

        final String id;
        final Opened opened;
        volatile boolean killed;
        private final AtomicInteger open = new AtomicInteger(2);

        PtyJob(String id, Opened opened) {
            this.id = id;
            this.opened = opened;
        }

        @Override
        public boolean killed() {
            return killed;
        }

        void pump(InputStream in) {
            byte[] buf = new byte[32768];
            try {
                int n;
                while ((n = in.read(buf)) > 0) events.ptyData(id, Arrays.copyOf(buf, n));
            } catch (IOException ignored) {
            }
            if (open.decrementAndGet() != 0) return;
            int code = exitCode(opened.session, this);
            opened.release();
            ptys.remove(id, this);
            events.ptyExit(id, code);
        }
    }

    private PtyJob pty(String ptyId) throws SshException {
        PtyJob job = ptyId == null ? null : ptys.get(ptyId);
        if (job == null) throw new SshException(NOT_FOUND, "no such pty: " + ptyId);
        return job;
    }

    // ---- helpers ---------------------------------------------------------------------------

    private Object lockFor(String id) {
        Object lock = locks.get(id);
        if (lock != null) return lock;
        Object fresh = new Object();
        lock = locks.putIfAbsent(id, fresh);
        return lock != null ? lock : fresh;
    }

    private static void drain(InputStream in, ByteArrayOutputStream sink) {
        byte[] buf = new byte[16384];
        try {
            int n;
            while ((n = in.read(buf)) > 0) {
                if (sink != null) sink.write(buf, 0, n);
            }
        } catch (IOException ignored) {
        }
    }

    /** False when the deadline passed first. */
    private static boolean await(Future<?> f, long deadline) {
        long left = deadline - System.currentTimeMillis();
        if (left <= 0) return f.isDone();
        try {
            f.get(left, TimeUnit.MILLISECONDS);
            return true;
        } catch (TimeoutException e) {
            return false;
        } catch (ExecutionException e) {
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static void awaitQuietly(Future<?> f, long ms) {
        try {
            f.get(ms, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (ExecutionException | TimeoutException ignored) {
        }
    }

    private static String utf8(ByteArrayOutputStream b) {
        return new String(b.toByteArray(), StandardCharsets.UTF_8);
    }

    static String fingerprint(byte[] hostKeyBlob) {
        return KeyFingerprint.createSHA256Fingerprint(hostKeyBlob);
    }

    /** The key type named inside the SSH key blob ("ssh-rsa" rather than the "rsa-sha2-512" signature name). */
    static String keyType(byte[] blob, String fallback) {
        if (blob != null && blob.length >= 4) {
            int n = ((blob[0] & 0xff) << 24) | ((blob[1] & 0xff) << 16) | ((blob[2] & 0xff) << 8) | (blob[3] & 0xff);
            if (n > 0 && n <= 64 && n <= blob.length - 4) return new String(blob, 4, n, StandardCharsets.US_ASCII);
        }
        return fallback;
    }

    static String normalizeFingerprint(String fp) {
        String s = fp.trim();
        while (s.endsWith("=")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private static String emptyToNull(String s) {
        return s == null || s.isEmpty() ? null : s;
    }

    private static SshException unreachable(String host, int port, Throwable e) {
        return new SshException(UNREACHABLE, "could not reach " + host + ":" + port + ": " + describe(e), e);
    }

    static String describe(Throwable e) {
        StringBuilder sb = new StringBuilder();
        Throwable t = e;
        for (int depth = 0; t != null && depth < 5; depth++, t = t.getCause()) {
            String m = t.getMessage();
            if (m == null || m.isEmpty() || sb.indexOf(m) >= 0) continue;
            if (sb.length() > 0) sb.append(": ");
            sb.append(m);
        }
        return sb.length() > 0 ? sb.toString() : e.getClass().getSimpleName();
    }

    private static ThreadFactory daemon(final String name) {
        final AtomicInteger n = new AtomicInteger();
        return r -> {
            Thread t = new Thread(r, name + "-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
    }
}
