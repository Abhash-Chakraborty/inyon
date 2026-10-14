import { expect, test } from "bun:test";
import { mb } from "./build.ts";

// /download said the APK was 2.7 MB while Chrome said 2.88 MB: sizes are decimal, as browsers count
test("sizes read as a browser shows them", () => {
  expect(mb(2_883_584)).toBe("2.9 MB");
  expect(mb(85_000_000)).toBe("85.0 MB");
  expect(mb(950_000)).toBe("950 KB");
  expect(mb(12)).toBe("1 KB");
});
