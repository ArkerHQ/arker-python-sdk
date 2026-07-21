import assert from "node:assert/strict";
import { createRequire } from "node:module";

const esm = await import("../dist/index.js");
const require = createRequire(import.meta.url);
const cjs = require("../dist/index.cjs");

assert.equal(typeof esm.Arker, "function");
assert.equal(typeof esm.ArkerError, "function");
assert.equal(typeof cjs.Arker, "function");
assert.equal(typeof cjs.ArkerError, "function");

console.log("PASS built Node imports");
