import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stampInstaller } from "../apps/node/installers.ts";
import { checkReleaseFile, mb, oldSiteLinks, parseSums } from "./build.ts";

// /download said the APK was 2.7 MB while Chrome said 2.88 MB: sizes are decimal, as browsers count
test("sizes read as a browser shows them", () => {
  expect(mb(2_883_584)).toBe("2.9 MB");
  expect(mb(85_000_000)).toBe("85.0 MB");
  expect(mb(950_000)).toBe("950 KB");
  expect(mb(12)).toBe("1 KB");
});


const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const node = (f: string) => readFileSync(join(import.meta.dir, "../apps/node", f), "utf8");

// the site publishes a release file only when the signed SHA256SUMS lists it with that checksum
test("a release file is published only as the signed list has it", () => {
  const program = Buffer.from("the program");
  const list = parseSums(`${sha(program)}  inyon-linux-x64\n${sha("get")} *get.sh\n`);
  const none = () => undefined;
  expect(() => checkReleaseFile("inyon-linux-x64", program, list, none)).not.toThrow();
  expect(() => checkReleaseFile("inyon-linux-x64", Buffer.from("tampered"), list, none)).toThrow("checksum mismatch");
  expect(() => checkReleaseFile("inyon-linux-arm64", program, list, none)).toThrow("not in SHA256SUMS");
  // the list can't name itself or its signature
  expect(() => checkReleaseFile("SHA256SUMS", Buffer.from("x"), list, none)).not.toThrow();
  expect(() => checkReleaseFile("SHA256SUMS.minisig", Buffer.from("x"), list, none)).not.toThrow();
  // from 0.20 the installers are in the list like everything else
  expect(() => checkReleaseFile("get.sh", Buffer.from("get"), list, none)).not.toThrow();
  expect(() => checkReleaseFile("get.sh", Buffer.from("#!/bin/sh\nevil\n"), list, () => Buffer.from("#!/bin/sh\nevil\n"))).toThrow(
    "checksum mismatch",
  );
});

test("an installer the list leaves out (before 0.20) has to be the tagged commit's own copy", () => {
  const list = parseSums("");
  const script = Buffer.from("#!/bin/sh\necho hi\n");
  expect(() => checkReleaseFile("get.ps1", script, list, () => Buffer.from(script))).not.toThrow();
  expect(() => checkReleaseFile("get.ps1", Buffer.from("#!/bin/sh\nevil\n"), list, () => script)).toThrow("not the copy in the release's tagged commit");
  expect(() => checkReleaseFile("get.sh", script, list, () => undefined)).toThrow("tag isn't here");
});

test("the installers served at the root carry the sha256 of the list the site checked", () => {
  const list = sha("the list");
  const sh = stampInstaller("get.sh", node("get.sh"), list);
  expect(sh).toContain(`\nLIST_SHA256=${list}\n`);
  expect(sh.replace(list, "")).toBe(node("get.sh"));
  const ps1 = stampInstaller("get.ps1", node("get.ps1"), list);
  expect(ps1).toContain(`\n$listSha256 = '${list}'\n`);
  expect(ps1.replace(list, "")).toBe(node("get.ps1"));
  // an installer from before 0.20 has no place for it and is served as it is
  expect(stampInstaller("get.sh", "#!/bin/sh\necho old\n", list)).toBe("#!/bin/sh\necho old\n");
  // one that names the slot but hasn't one empty line for it is refused rather than half filled
  expect(() => stampInstaller("get.sh", sh, list)).toThrow("expected one empty LIST_SHA256 line, found 0");
  expect(() => stampInstaller("get.sh", "LIST_SHA256=\nLIST_SHA256=\n", list)).toThrow("found 2");
  expect(() => stampInstaller("get.ps1", node("get.ps1"), "not a sha")).toThrow("isn't a sha256");
});

// release notes from before 23 Oct 2026 link to inyon.abhashchakraborty.tech; the changelog shows inyon.tech
test("old release notes link to the site's new address", () => {
  expect(oldSiteLinks("see [Install](https://inyon.abhashchakraborty.tech/docs/install/#x) or https://inyon.abhashchakraborty.tech")).toBe(
    "see [Install](https://inyon.tech/docs/install/#x) or https://inyon.tech",
  );
  expect(oldSiteLinks("`curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | sh`")).toBe("`curl -fsSL https://inyon.tech/get.sh | sh`");
  // a host that only starts the same stays as it is
  expect(oldSiteLinks("https://inyon.abhashchakraborty.tech.example.com/")).toBe("https://inyon.abhashchakraborty.tech.example.com/");
});
