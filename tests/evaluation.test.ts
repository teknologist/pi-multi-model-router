import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { evaluate, frozen } from "../scripts/evaluation.ts";
import { choiceResult, entries, registryFixture, request } from "./fixtures/router.ts";
import { routeRequest } from "../src/router.ts";

test("evaluation uses the frozen production questions and native classifier context", async () => {
  const entry = entries[0];
  assert.ok(entry);
  const f = registryFixture();
  await routeRequest(entry, request(entry), f.registry);
  const production = f.calls[0]?.context;
  assert.ok(production);
  assert.deepEqual(production.questions, { route: { type: "choice", instructions: frozen.instructions, criteria: frozen.criteria } });
  let calls = 0;
  const report = await evaluate(async (context) => {
    assert.deepEqual(context.questions, production.questions);
    const cases = [...frozen.core, ...frozen.holdout, ...frozen.contextual];
    const fixture = cases.find((item) => item.current === context.state.current && (item.recent ?? "") === context.state.recent);
    assert.ok(fixture);
    calls++;
    return choiceResult(fixture.expected);
  });
  assert.equal(calls, 52);
  assert.equal(report.pass, true);
  assert.deepEqual(report.summary.core.exact, [24, 24]);
  assert.deepEqual(report.summary.holdout.allowed, [24, 24]);
  assert.deepEqual(report.summary.contextual.exact, [4, 4]);
  assert.equal(report.errors, 0);
  assert.equal(report.deepToQuick, 0);
  assert.deepEqual(report.disagreements, []);
  assert.deepEqual(report.summary.core.counts, { quick: 8, balanced: 8, deep: 8 });
  assert.equal(report.summary.core.confusion.deep.deep, 8);
});

test("evaluation separates exact/allowed results, disagreements, API errors, and deep-to-quick failures", async () => {
  let boundaryCalls = 0;
  const report = await evaluate(async (context) => {
    if (context.state.current === frozen.core[4]?.current) return choiceResult(++boundaryCalls === 1 ? "quick" : "balanced");
    if (context.state.current === frozen.holdout[0]?.current) throw new Error("do not retain transport text");
    if (context.state.current === frozen.core[8]?.current) return choiceResult("quick");
    const fixture = [...frozen.core, ...frozen.holdout, ...frozen.contextual].find((item) => item.current === context.state.current && (item.recent ?? "") === context.state.recent);
    assert.ok(fixture);
    return choiceResult(fixture.expected);
  });
  assert.equal(report.pass, false);
  assert.deepEqual(report.summary.core.exact, [21, 24]);
  assert.deepEqual(report.summary.core.allowed, [22, 24]);
  assert.equal(report.errors, 2);
  assert.equal(report.deepToQuick, 2);
  assert.deepEqual(report.disagreements, [{ set: "core", id: "b1", choices: ["quick", "balanced"] }]);
  assert.ok(!JSON.stringify(report).includes("do not retain transport text"));
});

test("live evaluation refuses to load credentials or write output without explicit paid-call consent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "router-eval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(promisify(execFile)(process.execPath, ["--experimental-strip-types", resolve("scripts/evaluate-live.ts")], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, PI_CODING_AGENT_DIR: dir },
  }), (error: unknown) => {
    assert.ok(error instanceof Error && "stderr" in error);
    assert.match(String(error.stderr), /requires --allow-paid-typesafe and a new output path/);
    return true;
  });
  assert.deepEqual(await readdir(dir), []);
});

async function evaluationCli(t: TestContext, fault = "none") {
  const dir = await mkdtemp(join(tmpdir(), "router-eval-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hook = join(dir, "offline.mjs");
  const output = join(dir, "results.json");
  await writeFile(hook, `
    import assert from "node:assert/strict";
    import fs, { open, readFile, stat } from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { dirname } from "node:path";
    const fault = ${JSON.stringify(fault)};
    const output = ${JSON.stringify(output)};
    const handle = await open(${JSON.stringify(join(dir, "probe"))}, "wx");
    const prototype = Object.getPrototypeOf(handle);
    const write = prototype.write;
    const sync = prototype.sync;
    let writes = 0;
    let reportHandle;
    let pending;
    let synced = false;
    let renamed = false;
    let injected = false;
    const rename = fs.rename;
    fs.rename = async (source, target) => {
      assert.equal(dirname(source), dirname(output));
      assert.equal(target, output);
      assert.equal(synced, true, "sync the complete temporary report before rename");
      assert.equal(await readFile(output, "utf8"), pending);
      const report = JSON.parse(await readFile(source, "utf8"));
      assert.equal(report.pass, true);
      assert.equal(report.results.length, 52);
      if (fault === "rename") {
        injected = true;
        throw new Error("Injected report rename failure");
      }
      await rename(source, target);
      renamed = true;
    };
    syncBuiltinESMExports();
    prototype.write = async function(buffer, offset, length, position) {
      reportHandle = this;
      if (++writes === 2 && fault === "write") {
        injected = true;
        throw new Error("Injected report write failure");
      }
      if (writes === 2 && fault === "zero") {
        injected = true;
        return { bytesWritten: 0, buffer };
      }
      if (fault === "none") {
        const saved = await readFile(output, "utf8");
        assert.equal(saved, pending, "pending report must remain unchanged until publication");
        assert.equal(JSON.parse(saved).status, "pending");
        const temporary = await this.stat();
        assert.equal(temporary.mode & 0o777, 0o600);
        assert.notEqual(temporary.ino, (await stat(output)).ino, "write only to a separate file");
      }
      return write.call(this, buffer, offset, Math.min(length, 64), position);
    };
    prototype.sync = async function() {
      if (this === reportHandle && fault === "sync") {
        injected = true;
        throw new Error("Injected report sync failure");
      }
      await sync.call(this);
      if (this === reportHandle) synced = true;
    };
    await handle.close();
    const frozen = ${JSON.stringify(frozen)};
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer offline-dummy-typesafe");
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
      const fixture = [...frozen.core, ...frozen.holdout, ...frozen.contextual].find(item => item.current === body.state.current && (item.recent ?? "") === body.state.recent);
      assert.ok(fixture);
      pending ??= await readFile(output, "utf8");
      calls++;
      return Response.json({ answers: { route: { type: "choice", choice: fixture.expected, probabilities: { [fixture.expected]: 1 }, confidence: 1 } } });
    };
    process.on("beforeExit", () => {
      assert.equal(calls, 52);
      if (fault === "none") {
        assert.ok(writes > 1);
        assert.equal(renamed, true);
      } else {
        assert.equal(injected, true);
        assert.equal(renamed, false);
      }
    });
  `);
  const run = () => promisify(execFile)(process.execPath, [
    "--experimental-strip-types", "--import", pathToFileURL(hook).href,
    resolve("scripts/evaluate-live.ts"), "--allow-paid-typesafe", output,
  ], { env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir, PI_CODING_AGENT_DIR: dir, TYPESAFE_API_KEY: "offline-dummy-typesafe" }, timeout: 20000 });
  return { dir, output, run };
}

test("opt-in CLI uses native dummy auth, mocked HTTP, complete report writes, and exclusive output", async (t) => {
  const { dir, output, run } = await evaluationCli(t);
  const { stdout } = await run();
  assert.equal(JSON.parse(stdout).pass, true);
  const saved = await readFile(output, "utf8");
  const report = JSON.parse(saved);
  assert.equal(report.pass, true);
  assert.equal(report.results.length, 52);
  assert.deepEqual(report.frozen, frozen);
  assert.ok(!saved.includes("offline-dummy-typesafe"));
  await assert.rejects(promisify(execFile)(process.execPath, [
    "--experimental-strip-types", resolve("scripts/evaluate-live.ts"), "--allow-paid-typesafe", output,
  ], { env: { PATH: process.env.PATH ?? "", HOME: dir, PI_CODING_AGENT_DIR: dir }, timeout: 20000 }));
  assert.equal(await readFile(output, "utf8"), saved);
  assert.deepEqual((await readdir(dir)).sort(), ["auth.json", "models-store.json", "offline.mjs", "probe", "results.json"]);
});

for (const fault of ["write", "zero", "sync", "rename"]) {
  test(`CLI retains the complete pending report and removes its temporary file after ${fault} failure`, async (t) => {
    const { dir, output, run } = await evaluationCli(t, fault);
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof Error && "stderr" in error && "stdout" in error);
      assert.doesNotMatch(String(error.stderr), /AssertionError|ERR_ASSERTION/);
      assert.match(String(error.stderr), /Evaluation did not complete/);
      assert.equal(error.stdout, "");
      return true;
    });
    const pending = JSON.parse(await readFile(output, "utf8"));
    assert.equal(pending.status, "pending");
    assert.deepEqual(pending.frozen, frozen);
    assert.equal(typeof pending.startedAt, "string");
    assert.equal("pass" in pending, false);
    assert.equal("completedAt" in pending, false);
    assert.deepEqual((await readdir(dir)).sort(), ["auth.json", "models-store.json", "offline.mjs", "probe", "results.json"]);
  });
}
