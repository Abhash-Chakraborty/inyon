// Copies the release files `bun site/build.ts --mirror` checked (site/dl) to the R2 bucket behind
// dl.abhashchakraborty.tech, where installs and updates download from (0.17.1 on).
//
//   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… bun site/publish-downloads.ts [dir]
//
// A file whose sha256 is already there is skipped. The checksum list, its signature and
// latest.json go last, so they never name a file that isn't up yet, and files the release no
// longer has are deleted after that. Every file is cached for a minute only: the files keep their
// names from one release to the next, and a client must never get a new list with an old program.
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const DIR = process.argv[2] ?? join(import.meta.dir, "dl");
const BUCKET = process.env.R2_BUCKET || "inyon-downloads";
const CACHE = "public, max-age=60";
const LAST = ["SHA256SUMS", "SHA256SUMS.minisig", "latest.json"];

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} isn't set`);
  return v;
};

/** The Content-Type and, for programs and archives, an attachment disposition. */
export function typeOf(name: string): { type: string; attachment: boolean } {
  if (name === "SHA256SUMS" || /\.(minisig|sh|ps1|txt)$/.test(name)) return { type: "text/plain; charset=utf-8", attachment: false };
  switch (extname(name)) {
    case ".json":
      return { type: "application/json", attachment: false };
    case ".gz":
    case ".tgz":
      return { type: "application/gzip", attachment: true };
    case ".apk":
      return { type: "application/vnd.android.package-archive", attachment: true };
    default:
      return { type: "application/octet-stream", attachment: true };
  }
}

// RFC 3986, which SigV4 signs (encodeURIComponent leaves !'()* alone)
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** One S3 request to the bucket, signed with AWS Signature Version 4 (R2's region is "auto"). */
async function s3(method: string, key: string, opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: Buffer } = {}) {
  const host = `${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  const path = key ? `/${BUCKET}/${key.split("/").map(enc).join("/")}` : `/${BUCKET}`;
  const query = Object.entries(opts.query ?? {})
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .sort()
    .join("&");
  const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {
    host,
    "x-amz-date": stamp,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const names = Object.keys(headers).sort();
  const signed = names.join(";");
  const request = [method, path, query, names.map((n) => `${n}:${headers[n].trim()}\n`).join(""), signed, "UNSIGNED-PAYLOAD"].join("\n");
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(request)].join("\n");
  const signingKey = ["auto", "s3", "aws4_request"].reduce((k, part) => hmac(k, part), hmac(`AWS4${env("R2_SECRET_ACCESS_KEY")}`, day));
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  const { host: _, ...sent } = headers;
  return fetch(`https://${host}${path}${query ? `?${query}` : ""}`, {
    method,
    headers: { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${env("R2_ACCESS_KEY_ID")}/${scope}, SignedHeaders=${signed}, Signature=${signature}` },
    body: opts.body,
  });
}

async function put(name: string, data: Buffer, sha: string) {
  const { type, attachment } = typeOf(name);
  const head = await s3("HEAD", name);
  if (head.ok && head.headers.get("x-amz-meta-sha256") === sha && head.headers.get("content-type") === type && head.headers.get("cache-control") === CACHE) {
    console.log(`  ${name} unchanged`);
    return;
  }
  const headers: Record<string, string> = { "content-type": type, "cache-control": CACHE, "x-amz-meta-sha256": sha };
  if (attachment) headers["content-disposition"] = `attachment; filename="${name}"`;
  const res = await s3("PUT", name, { headers, body: data });
  if (!res.ok) throw new Error(`upload ${name}: ${res.status} ${await res.text()}`);
  console.log(`  ${name} uploaded (${(data.length / 1048576).toFixed(1)} MB)`);
}

/** The keys at the bucket's top level (folders, if there ever are any, are left alone). */
async function listTop(): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3("GET", "", { query: { "list-type": "2", delimiter: "/", ...(token ? { "continuation-token": token } : {}) } });
    if (!res.ok) throw new Error(`list: ${res.status} ${await res.text()}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, "&"));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([^<]+)</)?.[1] : undefined;
  } while (token);
  return keys;
}

async function main() {
  const files = readdirSync(DIR).filter((f) => !f.startsWith("."));
  for (const name of LAST) if (!files.includes(name)) throw new Error(`${DIR} has no ${name}: run bun site/build.ts --mirror first`);
  console.log(`publishing ${files.length} files to ${BUCKET}`);
  const order = [...files.filter((f) => !LAST.includes(f)).sort(), ...LAST];
  for (const name of order) {
    const data = readFileSync(join(DIR, name));
    await put(name, data, sha256(data));
  }
  for (const key of await listTop()) {
    if (files.includes(key)) continue;
    const res = await s3("DELETE", key);
    if (!res.ok && res.status !== 404) throw new Error(`delete ${key}: ${res.status}`);
    console.log(`  ${key} deleted (not in this release)`);
  }
}

if (import.meta.main) await main();
