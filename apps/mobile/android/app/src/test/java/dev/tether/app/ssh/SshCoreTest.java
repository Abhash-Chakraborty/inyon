package dev.tether.app.ssh;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;
import static org.junit.Assume.assumeTrue;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Runs against a real sshd given by TETHER_SSH_TEST_HOST / _PORT / _USER / _KEY (an unencrypted
 * OpenSSH ed25519 private key file) and optionally _PASSWORD. Without them the server tests skip.
 */
public class SshCoreTest {

    private static final String HOST = System.getenv("TETHER_SSH_TEST_HOST");
    private static final String PORT = System.getenv("TETHER_SSH_TEST_PORT");
    private static final String USER = System.getenv("TETHER_SSH_TEST_USER");
    private static final String KEY = System.getenv("TETHER_SSH_TEST_KEY");
    private static final String PASSWORD = System.getenv("TETHER_SSH_TEST_PASSWORD");
    private static final String ID = "test-server";

    private Recorder events;
    private SshCore core;

    @Before
    public void setUp() {
        events = new Recorder();
        core = new SshCore(events);
    }

    @After
    public void tearDown() {
        core.shutdown();
    }

    // ---- offline -------------------------------------------------------------------------------

    @Test
    public void lineSplitterHandlesPartialLinesCrlfAndSplitCharacters() {
        LineSplitter s = new LineSplitter();
        byte[] all = "one\r\ntw\u00f6\n\nthree".getBytes(StandardCharsets.UTF_8);
        List<String> lines = new ArrayList<>();
        // feed one byte at a time so the two-byte character is cut in half
        for (int i = 0; i < all.length; i++) lines.addAll(s.feed(all, i, 1));
        assertEquals(Arrays.asList("one", "tw\u00f6", ""), lines);
        assertEquals("three", s.finish());
        assertNull(s.finish());
    }

    @Test
    public void keyTypeComesFromTheBlob() {
        byte[] name = "ssh-ed25519".getBytes(StandardCharsets.US_ASCII);
        byte[] blob = new byte[4 + name.length + 4];
        blob[3] = (byte) name.length;
        System.arraycopy(name, 0, blob, 4, name.length);
        assertEquals("ssh-ed25519", SshCore.keyType(blob, "fallback"));
        assertEquals("fallback", SshCore.keyType(new byte[2], "fallback"));
        assertEquals("SHA256:abc", SshCore.normalizeFingerprint(" SHA256:abc= "));
    }

    @Test
    public void notConnectedIsReported() {
        try {
            core.exec("nope", "true", null, 1000);
            fail("expected NOT_CONNECTED");
        } catch (SshCore.SshException e) {
            assertEquals(SshCore.NOT_CONNECTED, e.code);
        }
    }

    // ---- against a server ----------------------------------------------------------------------

    @Test
    public void probeReturnsSha256Fingerprint() throws Exception {
        requireServer();
        SshCore.HostKey key = core.probe(HOST, port());
        assertTrue(key.fingerprint, key.fingerprint.matches("SHA256:[A-Za-z0-9+/]{43}"));
        assertNotNull(key.keyType);
        assertTrue(key.keyType, key.keyType.startsWith("ssh-") || key.keyType.startsWith("ecdsa-"));
    }

    @Test
    public void connectsWithEd25519SeedAndReconnectIsANoOp() throws Exception {
        connect();
        long t = System.nanoTime();
        core.connect(ID, HOST, port(), hostKey(), seedCredentials());
        assertTrue("second connect should not log in again", System.nanoTime() - t < TimeUnit.MILLISECONDS.toNanos(200));
        assertEquals("ok\n", core.exec(ID, "echo ok", null, 0).stdout);
    }

    @Test
    public void connectsWithPrivateKeyText() throws Exception {
        requireServer();
        SshCore.Credentials c = new SshCore.Credentials();
        c.username = USER;
        c.privateKey = new String(Files.readAllBytes(Paths.get(KEY)), StandardCharsets.UTF_8);
        core.connect(ID, HOST, port(), hostKey(), c);
        assertEquals(0, core.exec(ID, "true", null, 0).code);
    }

    @Test
    public void connectsWithPassword() throws Exception {
        requireServer();
        assumeTrue("TETHER_SSH_TEST_PASSWORD not set", PASSWORD != null && !PASSWORD.isEmpty());
        SshCore.Credentials c = new SshCore.Credentials();
        c.username = USER;
        c.password = PASSWORD;
        core.connect(ID, HOST, port(), hostKey(), c);
        assertEquals(0, core.exec(ID, "true", null, 0).code);
    }

    @Test
    public void hostKeyMismatchIsRejected() throws Exception {
        requireServer();
        try {
            core.connect(ID, HOST, port(), "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", seedCredentials());
            fail("expected HOST_KEY_MISMATCH");
        } catch (SshCore.SshException e) {
            assertEquals(SshCore.HOST_KEY_MISMATCH, e.code);
        }
    }

    @Test
    public void wrongKeyIsAuthFailed() throws Exception {
        requireServer();
        SshCore.Credentials c = seedCredentials();
        c.ed25519Seed = new byte[32];
        c.ed25519Public = new byte[32];
        c.ed25519Public[0] = 1;
        try {
            core.connect(ID, HOST, port(), hostKey(), c);
            fail("expected AUTH_FAILED");
        } catch (SshCore.SshException e) {
            assertEquals(SshCore.AUTH_FAILED, e.code);
        }
    }

    @Test
    public void unreachableIsReported() throws Exception {
        try {
            core.probe("127.0.0.1", 1);
            fail("expected UNREACHABLE");
        } catch (SshCore.SshException e) {
            assertEquals(SshCore.UNREACHABLE, e.code);
        }
    }

    @Test
    public void execReturnsStdoutStderrAndCode() throws Exception {
        connect();
        SshCore.ExecResult r = core.exec(ID, "sh -c 'echo out; echo err >&2; exit 7'", null, 0);
        assertEquals(7, r.code);
        assertEquals("out\n", r.stdout);
        assertEquals("err\n", r.stderr);
    }

    @Test
    public void execHandlesLargeOutputOnBothStreams() throws Exception {
        connect();
        // ~4 MB on stdout and ~1 MB on stderr at the same time
        SshCore.ExecResult r = core.exec(ID, "sh -c 'head -c 1000000 /dev/zero | tr \"\\0\" e >&2 & head -c 4000000 /dev/zero | tr \"\\0\" o; wait'", null, 30000);
        assertEquals(0, r.code);
        assertEquals(4000000, r.stdout.length());
        assertEquals(1000000, r.stderr.length());
    }

    @Test
    public void execWritesStdin() throws Exception {
        connect();
        byte[] input = "hello\nworld\n".getBytes(StandardCharsets.UTF_8);
        SshCore.ExecResult r = core.exec(ID, "cat", input, 0);
        assertEquals(0, r.code);
        assertEquals("hello\nworld\n", r.stdout);
        // without stdin the command sees EOF instead of hanging
        assertEquals(0, core.exec(ID, "cat", null, 5000).code);
    }

    @Test
    public void execTimeoutReturns124() throws Exception {
        connect();
        long t = System.currentTimeMillis();
        SshCore.ExecResult r = core.exec(ID, "sh -c 'echo started; sleep 10'", null, 1000);
        assertTrue("took " + (System.currentTimeMillis() - t) + " ms", System.currentTimeMillis() - t < 5000);
        assertEquals(124, r.code);
        assertEquals("started\n", r.stdout);
        assertTrue(r.stderr, r.stderr.endsWith("timed out"));
    }

    @Test
    public void streamDeliversLinesInOrderAndExitCode() throws Exception {
        connect();
        core.stream(ID, "s1", "sh -c 'i=0; while [ $i -lt 500 ]; do echo line$i; i=$((i+1)); done; printf tail; exit 3'", false);
        assertEquals(3, events.awaitStreamExit("s1", 15000));
        List<String> lines = events.lines("s1");
        assertEquals(501, lines.size());
        for (int i = 0; i < 500; i++) assertEquals("line" + i, lines.get(i));
        assertEquals("tail", lines.get(500));
    }

    @Test
    public void streamWithKeepStdinStaysOpen() throws Exception {
        connect();
        // cat exits as soon as stdin closes
        core.stream(ID, "cat", "sh -c 'echo ready; cat'", true);
        events.awaitLine("cat", "ready", 10000);
        Thread.sleep(500);
        assertNull("cat exited although stdin was kept open", events.streamExitCode("cat"));
        core.streamKill("cat");
        assertEquals(143, events.awaitStreamExit("cat", 10000));
    }

    @Test
    public void streamKillStopsIt() throws Exception {
        connect();
        core.stream(ID, "tick", "sh -c 'while true; do echo tick; sleep 0.1; done'", false);
        events.awaitLine("tick", "tick", 10000);
        core.streamKill("tick");
        assertEquals(143, events.awaitStreamExit("tick", 10000));
    }

    @Test
    public void ptyEchoAndResize() throws Exception {
        connect();
        core.pty(ID, "p1", "sh -c 'echo hi; sleep 1; stty size'", 80, 24);
        events.awaitPtyOutput("p1", "hi", 10000);
        core.ptyResize("p1", 100, 30);
        assertEquals(0, events.awaitPtyExit("p1", 10000));
        assertTrue(events.ptyOutput("p1"), events.ptyOutput("p1").contains("30 100"));
    }

    @Test
    public void ptyWriteReachesTheProgram() throws Exception {
        connect();
        core.pty(ID, "p2", "sh -c 'read line; echo got:$line'", 80, 24);
        Thread.sleep(300);
        core.ptyWrite("p2", "abc\r".getBytes(StandardCharsets.UTF_8));
        assertEquals(0, events.awaitPtyExit("p2", 10000));
        assertTrue(events.ptyOutput("p2"), events.ptyOutput("p2").contains("got:abc"));
    }

    @Test
    public void ptyKillEndsIt() throws Exception {
        connect();
        core.pty(ID, "p3", "sleep 30", 80, 24);
        Thread.sleep(300);
        core.ptyKill("p3");
        assertEquals(143, events.awaitPtyExit("p3", 10000));
    }

    @Test
    public void fifteenConcurrentStreamsUseMoreThanOneConnection() throws Exception {
        connect();
        // MaxSessions defaults to 10 per connection, so these can't all fit on one
        int n = 15;
        for (int i = 0; i < n; i++) core.stream(ID, "c" + i, "sh -c 'echo start; sleep 3; echo end'", false);
        for (int i = 0; i < n; i++) events.awaitLine("c" + i, "start", 20000);
        // with every stream still running, plain execs still get a session
        assertEquals("x\n", core.exec(ID, "echo x", null, 10000).stdout);
        for (int i = 0; i < n; i++) {
            assertEquals(0, events.awaitStreamExit("c" + i, 20000));
            assertEquals(Arrays.asList("start", "end"), events.lines("c" + i));
        }
    }

    @Test
    public void concurrentExecs() throws Exception {
        connect();
        ExecutorService ex = Executors.newFixedThreadPool(20);
        try {
            List<Future<SshCore.ExecResult>> results = new ArrayList<>();
            for (int i = 0; i < 20; i++) {
                final int k = i;
                results.add(ex.submit(() -> core.exec(ID, "sh -c 'sleep 1; echo " + k + "'", null, 20000)));
            }
            for (int i = 0; i < 20; i++) assertEquals(i + "\n", results.get(i).get(30, TimeUnit.SECONDS).stdout);
        } finally {
            ex.shutdownNow();
        }
    }

    @Test
    public void disconnectClosesEverything() throws Exception {
        connect();
        core.stream(ID, "d1", "sh -c 'while true; do echo tick; sleep 0.2; done'", false);
        core.pty(ID, "d2", "sleep 60", 80, 24);
        events.awaitLine("d1", "tick", 10000);
        core.disconnect(ID);
        assertEquals(255, events.awaitStreamExit("d1", 10000));
        assertEquals(255, events.awaitPtyExit("d2", 10000));
        try {
            core.exec(ID, "true", null, 1000);
            fail("expected NOT_CONNECTED");
        } catch (SshCore.SshException e) {
            assertEquals(SshCore.NOT_CONNECTED, e.code);
        }
        assertTrue("an explicit disconnect is not a drop", events.closedIds().isEmpty());
    }

    @Test
    public void droppedConnectionEmitsClosedAndEndsStreams() throws Exception {
        connect();
        core.stream(ID, "drop", "sh -c 'while true; do echo tick; sleep 0.2; done'", false);
        events.awaitLine("drop", "tick", 10000);
        // the shell's parent is the sshd process serving this connection
        core.exec(ID, "sh -c 'kill -9 $PPID'", null, 3000);
        assertEquals(255, events.awaitStreamExit("drop", 10000));
        events.awaitClosed(ID, 10000);
        try {
            core.exec(ID, "true", null, 1000);
            fail("expected NOT_CONNECTED");
        } catch (SshCore.SshException e) {
            assertEquals(SshCore.NOT_CONNECTED, e.code);
        }
    }

    // ---- helpers -------------------------------------------------------------------------------

    private static void requireServer() {
        assumeTrue("TETHER_SSH_TEST_* not set", HOST != null && USER != null && KEY != null);
    }

    private static int port() {
        return PORT == null || PORT.isEmpty() ? 22 : Integer.parseInt(PORT);
    }

    private static String hostKey;

    // probed once: newer sshd versions penalise sources that keep connecting without logging in
    private String hostKey() throws Exception {
        if (hostKey == null) hostKey = core.probe(HOST, port()).fingerprint;
        return hostKey;
    }

    private static SshCore.Credentials seedCredentials() throws Exception {
        OpenSshEd25519 key = OpenSshEd25519.parse(new String(Files.readAllBytes(Paths.get(KEY)), StandardCharsets.UTF_8));
        SshCore.Credentials c = new SshCore.Credentials();
        c.username = USER;
        c.ed25519Seed = key.seed;
        c.ed25519Public = key.publicKey;
        return c;
    }

    private void connect() throws Exception {
        requireServer();
        core.connect(ID, HOST, port(), hostKey(), seedCredentials());
    }

    /** Collects events and lets tests wait for them. */
    private static final class Recorder implements SshCore.Events {

        private final Map<String, List<String>> lines = new HashMap<>();
        private final Map<String, Integer> streamExits = new HashMap<>();
        private final Map<String, ByteArrayOutputStream> ptyData = new HashMap<>();
        private final Map<String, Integer> ptyExits = new HashMap<>();
        private final List<String> closed = new ArrayList<>();

        @Override
        public synchronized void streamLines(String streamId, List<String> batch) {
            if (streamExits.containsKey(streamId)) throw new AssertionError("lines after exit on " + streamId);
            List<String> l = lines.get(streamId);
            if (l == null) lines.put(streamId, l = new ArrayList<>());
            l.addAll(batch);
            notifyAll();
        }

        @Override
        public synchronized void streamExit(String streamId, int code) {
            if (streamExits.put(streamId, code) != null) throw new AssertionError("second exit on " + streamId);
            notifyAll();
        }

        @Override
        public synchronized void ptyData(String ptyId, byte[] data) {
            ByteArrayOutputStream b = ptyData.get(ptyId);
            if (b == null) ptyData.put(ptyId, b = new ByteArrayOutputStream());
            b.write(data, 0, data.length);
            notifyAll();
        }

        @Override
        public synchronized void ptyExit(String ptyId, int code) {
            ptyExits.put(ptyId, code);
            notifyAll();
        }

        @Override
        public synchronized void closed(String serverId, String reason) {
            closed.add(serverId);
            notifyAll();
        }

        synchronized List<String> lines(String id) {
            List<String> l = lines.get(id);
            return l == null ? Collections.<String>emptyList() : new ArrayList<>(l);
        }

        synchronized Integer streamExitCode(String id) {
            return streamExits.get(id);
        }

        synchronized String ptyOutput(String id) {
            ByteArrayOutputStream b = ptyData.get(id);
            return b == null ? "" : new String(b.toByteArray(), StandardCharsets.UTF_8);
        }

        synchronized List<String> closedIds() {
            return new ArrayList<>(closed);
        }

        synchronized int awaitStreamExit(String id, long ms) throws InterruptedException {
            long end = System.currentTimeMillis() + ms;
            while (!streamExits.containsKey(id)) waitUntil(end, "streamExit " + id);
            return streamExits.get(id);
        }

        synchronized int awaitPtyExit(String id, long ms) throws InterruptedException {
            long end = System.currentTimeMillis() + ms;
            while (!ptyExits.containsKey(id)) waitUntil(end, "ptyExit " + id + " (output: " + ptyOutput(id) + ")");
            return ptyExits.get(id);
        }

        synchronized void awaitLine(String id, String line, long ms) throws InterruptedException {
            long end = System.currentTimeMillis() + ms;
            while (!lines(id).contains(line)) waitUntil(end, "line '" + line + "' on " + id);
        }

        synchronized void awaitClosed(String id, long ms) throws InterruptedException {
            long end = System.currentTimeMillis() + ms;
            while (!closed.contains(id)) waitUntil(end, "closed " + id);
        }

        synchronized void awaitPtyOutput(String id, String text, long ms) throws InterruptedException {
            long end = System.currentTimeMillis() + ms;
            while (!ptyOutput(id).contains(text)) waitUntil(end, "'" + text + "' on pty " + id);
        }

        private void waitUntil(long end, String what) throws InterruptedException {
            long left = end - System.currentTimeMillis();
            if (left <= 0) throw new AssertionError("timed out waiting for " + what);
            wait(left);
        }
    }
}
