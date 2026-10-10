package dev.tether.app.ssh;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;

/**
 * Reads an unencrypted OpenSSH ed25519 private key ("-----BEGIN OPENSSH PRIVATE KEY-----") into
 * the 32-byte seed and 32-byte public key, the form the app passes keys it generated itself.
 */
final class OpenSshEd25519 {

    final byte[] seed;
    final byte[] publicKey;

    private OpenSshEd25519(byte[] seed, byte[] publicKey) {
        this.seed = seed;
        this.publicKey = publicKey;
    }

    static OpenSshEd25519 parse(String text) throws IOException {
        String body = text
            .replace("-----BEGIN OPENSSH PRIVATE KEY-----", "")
            .replace("-----END OPENSSH PRIVATE KEY-----", "")
            .replaceAll("\\s", "");
        ByteBuffer b = ByteBuffer.wrap(Base64.getDecoder().decode(body));
        byte[] magic = "openssh-key-v1\0".getBytes(StandardCharsets.US_ASCII);
        byte[] head = new byte[magic.length];
        b.get(head);
        if (!Arrays.equals(head, magic)) throw new IOException("not an OpenSSH private key");
        String cipher = string(b);
        string(b); // kdf name
        bytes(b); // kdf options
        if (!"none".equals(cipher)) throw new IOException("encrypted keys are not supported here");
        if (b.getInt() != 1) throw new IOException("expected exactly one key");
        bytes(b); // public key blob
        ByteBuffer priv = ByteBuffer.wrap(bytes(b));
        if (priv.getInt() != priv.getInt()) throw new IOException("corrupt private key (check ints differ)");
        String type = string(priv);
        if (!"ssh-ed25519".equals(type)) throw new IOException("not an ed25519 key: " + type);
        byte[] pub = bytes(priv);
        byte[] secret = bytes(priv); // seed followed by the public key
        if (pub.length != 32 || secret.length != 64) throw new IOException("unexpected ed25519 key sizes");
        return new OpenSshEd25519(Arrays.copyOf(secret, 32), pub);
    }

    private static byte[] bytes(ByteBuffer b) {
        byte[] out = new byte[b.getInt()];
        b.get(out);
        return out;
    }

    private static String string(ByteBuffer b) {
        return new String(bytes(b), StandardCharsets.UTF_8);
    }
}
