import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { nativeFixture } from "./native.ts";

const [mode, dir, provider, id, entrypoint, sessionFile] = process.argv.slice(2);
assert.ok(mode && dir && provider && id && entrypoint);
assert.ok(["write", "read", "negative", "missing"].includes(mode));
let classifierUrl = "";
const requests: string[] = [];
const unexpected: string[] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url !== classifierUrl) {
    unexpected.push(url);
    throw new Error(`Unexpected cold-process endpoint: ${url}`);
  }
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer offline-dummy-typesafe");
  requests.push(url);
  const choice = mode === "write" ? "quick" : "deep";
  return Response.json({ answers: { route: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 } } });
};
const f = await nativeFixture(dir, {
  entrypoint, persist: true, router: mode !== "negative", ...(sessionFile ? { sessionFile } : {}),
});
try {
  const jev = f.runtime.getModelOfType("classifier", "typesafe", "jev-latest");
  assert.ok(jev);
  classifierUrl = `${jev.baseUrl.replace(/\/$/, "")}/systemone`;
  const before = [f.session.model?.provider, f.session.model?.id];
  if (mode === "write") {
    assert.deepEqual(before, ["control", "default-write"]);
    await f.select(provider, id);
  } else if (mode === "read" || mode === "missing") {
    assert.equal(f.services.settingsManager.getDefaultModel(), "default-read");
    assert.deepEqual(before, [provider, id], "services must register the virtual model BEFORE session restoration");
    assert.equal(f.dispatched().length, 1, "the persisted physical answer must exist before the next turn");
  } else {
    assert.equal(f.runtime.getModel(provider, id), undefined);
    assert.notDeepEqual(before, [provider, id], "without the router, virtual restoration must not pass");
    assert.equal(f.dispatched().length, 2);
  }
  let stickyError: string | undefined;
  function routeState() {
    const entry = f.manager.getBranch().findLast((e) => e.type === "custom" && e.customType === "pi.virtual-model-state");
    return entry?.type === "custom" ? (entry.data as { state: unknown }).state : undefined;
  }
  const state = routeState();
  if (mode === "missing") {
    assert.ok(state, "authored state must survive a cold restore");
    const quickProvider = id === "auto" ? "openai-codex" : "local-engine";
    const quickModel = id === "auto" ? "gpt-6.1-terra" : "qwen3.8-27b";
    const fake = f.physical.find((p) => p.provider.id === quickProvider);
    assert.ok(fake);
    f.runtime.registerNativeProvider({ ...fake.provider,
      getModels: () => fake.provider.getModels().filter((model) => model.id !== quickModel),
      getAllModels: () => (fake.provider.getAllModels?.() ?? fake.provider.getModels()).filter((model) => model.id !== quickModel),
    });
    await f.runtime.refresh({ allowNetwork: false });
    const virtual = f.runtime.getModel(provider, id);
    assert.ok(virtual);
    for (const reason of ["continuation", "retry"] as const) {
      stickyError = undefined;
      try {
        await f.runtime.resolveModel(virtual, [], { reason, thinkingLevel: "high", state });
      } catch (error) {
        assert.ok(error instanceof Error);
        stickyError = error.message;
      }
      assert.match(stickyError ?? "", /sticky target/);
    }
    assert.match(stickyError ?? "", /sticky target/);
    assert.equal(f.calls(), 0);
    assert.equal(requests.length, 0);
  } else if (mode !== "negative") {
    f.respond([fauxAssistantMessage(`offline ${mode}`)]);
    await f.session.prompt(`cold process ${mode}`);
    assert.deepEqual([f.session.model?.provider, f.session.model?.id], [provider, id]);
    assert.equal(requests.length, 1);
    assert.equal(f.calls(), 1);
  }
  assert.deepEqual(unexpected, []);
  const path = f.session.sessionFile;
  assert.ok(path);
  const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
  assert.ok(records.length > 2);
  console.log(JSON.stringify({
    pid: process.pid, before, selected: [f.session.model?.provider, f.session.model?.id],
    dispatched: f.dispatched(), path, requests: requests.length, state: routeState(), stickyError,
  }));
} finally {
  f.session.dispose();
}
