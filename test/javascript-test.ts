import assert from "assert";
import {readdirSync, statSync} from "fs";
import {readFile, unlink, writeFile} from "fs/promises";
import {basename, join, resolve} from "path";
import {transpileJavaScript} from "../src/javascript.js";

describe("transpileJavaScript(input)", () => {
  for (const name of readdirSync("./test/input")) {
    if (!name.endsWith(".js")) continue;
    const path = join("./test/input", name);
    if (!statSync(path).isFile()) continue;
    it(`test/input/${name}`, async () => {
      const outfile = resolve("./test/output", `${basename(name, ".js")}.js`);
      const diffile = resolve("./test/output", `${basename(name, ".js")}-changed.js`);
      const actual = await transpileJavaScript(await readFile(path, "utf8"), 0);
      let expected;

      try {
        expected = await readFile(outfile, "utf8");
      } catch (error) {
        if (error.code === "ENOENT" && process.env.CI !== "true") {
          console.warn(`! generating ${outfile}`);
          await writeFile(outfile, actual, "utf8");
          return;
        } else {
          throw error;
        }
      }

      const equal = expected === actual;

      if (equal) {
        if (process.env.CI !== "true") {
          try {
            await unlink(diffile);
            console.warn(`! deleted ${diffile}`);
          } catch (error) {
            if (error.code !== "ENOENT") {
              throw error;
            }
          }
        }
      } else {
        console.warn(`! generating ${diffile}`);
        await writeFile(diffile, actual, "utf8");
      }

      assert.ok(equal, `${name} must match snapshot`);
    });
  }
});
