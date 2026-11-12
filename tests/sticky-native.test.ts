import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { configure, isolatedEnvironment, nativeFixture } from "./fixtures/native.ts";
import { entries, exampleSource, expectedPairs } from "./fixtures/router.ts";

async function fixture(t: TestContext, options: Parameters<typeof nativeFixture>[1] = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-router-sticky-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = process.env;
  process.env = isolatedEnvironment(dir);
  t.after(() => { process.env = env; });
  await configure(dir, exampleSource);
  const f = await nativeFixture(dir, options);
  t.after(() => f.session.dispose());
  let choice = "quick";
  let classifications = 0;
  const classifier = f.runtime.getModelOfType("classifier", "typesafe", "jev-latest");
  assert.ok(classifier);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(String(input), `${classifier.baseUrl.replace(/\/$/, "")}/systemone`);
    classifications++;
    return Response.json({ answers: { route: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 } } });
  });
  async function remove(provider: string, id: string) {
    const fake = f.physical.find((p) => p.provider.id === provider);
    assert.ok(fake);
    f.runtime.registerNativeProvider({
      ...fake.provider,
      getModels: () => fake.provider.getModels().filter((model) => model.id !== id),
      getAllModels: () => (fake.provider.getAllModels?.() ?? fake.provider.getModels()).filter((model) => model.id !== id),
    });
    await f.runtime.refresh({ allowNetwork: false });
    assert.equal(f.runtime.getPhysicalModel(provider, id), undefined);
  }
  function state() {
    const entry = f.manager.getBranch().findLast((e) => e.type === "custom" && e.customType === "pi.virtual-model-state");
    assert.ok(entry?.type === "custom");
    const data = entry.data as { state: unknown };
    return data.state;
  }
  function states() {
    return f.manager.getBranch().filter((e) => e.type === "custom" && e.customType === "pi.virtual-model-state");
  }
  return { ...f, dir, remove, state, states, choose(value: string) { choice = value; }, classifications: () => classifications };
}

for (const entry of entries) {
  const quick = entry.routes.quick;
  assert.ok(quick);
  const unavailable = new RegExp(`sticky target ${quick.provider}/${quick.model.replaceAll(".", "\\.")} is not an available physical model`);

  test(`native removed previous ${entry.id} errors during tool continuation instead of fallback`, async (t) => {
    let remove = async () => {};
    const f = await fixture(t, { customTools: [{
      name: "remove", label: "Remove", description: "Remove the offline model", parameters: { type: "object", properties: {} },
      execute: async () => { await remove(); return { content: [{ type: "text", text: "removed" }], details: {} }; },
    }] });
    remove = () => f.remove(quick.provider, quick.model);
    await f.select(entry.provider, entry.id);
    f.respond([fauxAssistantMessage(fauxToolCall("remove", {}), { stopReason: "toolUse" }), fauxAssistantMessage("must not dispatch")]);
    await f.session.prompt("Use the remove tool");
    const last = f.session.messages.findLast((message) => message.role === "assistant");
    assert.equal(last?.stopReason, "error");
    assert.match(last?.errorMessage ?? "", unavailable);
    assert.equal(f.calls(), 1);
    assert.equal(f.classifications(), 1);
    assert.equal(f.session.model?.id, entry.id);
  });

  test(`native removed failed ${entry.id} errors on retry instead of older success`, async (t) => {
    const f = await fixture(t);
    await f.select(entry.provider, entry.id);
    f.choose("deep");
    f.respond([fauxAssistantMessage("older success")]);
    await f.session.prompt("First turn");
    f.choose("quick");
    f.respond([async () => {
      await f.remove(quick.provider, quick.model);
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
    }, fauxAssistantMessage("must not dispatch")]);
    await f.session.prompt("Second turn");
    const last = f.session.messages.findLast((message) => message.role === "assistant");
    assert.equal(last?.stopReason, "error");
    assert.match(last?.errorMessage ?? "", unavailable);
    assert.equal(f.calls(), 2, "retry must not dispatch on the older deep success");
    assert.equal(f.classifications(), 2);
  });

  test(`native ${entry.id} raw success detects removal without authored state`, async (t) => {
    const f = await fixture(t);
    const virtual = await f.select(entry.provider, entry.id);
    const messages = [{ ...fauxAssistantMessage("legacy success"), provider: quick.provider, model: quick.model, thinkingLevel: "off" as const }];
    await f.remove(quick.provider, quick.model);
    await assert.rejects(f.runtime.resolveModel(virtual, messages, { reason: "continuation", thinkingLevel: "high" }), unavailable);
    assert.equal(f.calls(), 0);
    assert.equal(f.classifications(), 0);
  });

  test(`native ${entry.id} missing identity and state retain fallback; direct does not mutate state`, async (t) => {
    const f = await fixture(t);
    const virtual = await f.select(entry.provider, entry.id);
    for (const reason of ["continuation", "retry"] as const) {
      const route = await f.runtime.resolveModel(virtual, [], { reason, thinkingLevel: "high" });
      assert.deepEqual([route.model.provider, route.model.id, route.thinkingLevel], expectedPairs[entry.id]?.balanced);
    }
    f.respond([fauxAssistantMessage("quick success")]);
    await f.session.prompt("A quick question");
    const state = f.state();
    const count = f.states().length;
    const messages = f.session.messages.filter((message) => message.role === "assistant");
    for (const reason of ["continuation", "retry"] as const) {
      const route = await f.runtime.resolveModel(virtual, messages, { reason, thinkingLevel: "high", state });
      assert.equal(route.state, state, "an unchanged identity must reuse the same state object");
      assert.equal(route.thinkingLevel, expectedPairs[entry.id]?.quick?.[2]);
    }
    const direct = await f.runtime.resolveModel(virtual, messages, { reason: "direct", thinkingLevel: "high", state });
    assert.equal(direct.state, undefined);
    assert.deepEqual([direct.model.provider, direct.model.id, direct.thinkingLevel], expectedPairs[entry.id]?.balanced);
    assert.equal(f.state(), state);
    assert.equal(f.states().length, count);
  });

  test(`native ${entry.id} available failed wins over conflicting state and previous, including off`, async (t) => {
    const f = await fixture(t);
    const virtual = await f.select(entry.provider, entry.id);
    const failed = { ...fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
      provider: quick.provider, model: quick.model, thinkingLevel: "off" as const };
    const previous = entry.routes.deep;
    assert.ok(previous);
    const route = await f.runtime.resolveModel(virtual, [{ ...fauxAssistantMessage("older"), provider: previous.provider, model: previous.model }], {
      reason: "retry", thinkingLevel: "high", failed, state: { provider: "gone", modelId: "gone" },
    });
    assert.deepEqual([route.model.provider, route.model.id, route.thinkingLevel], [quick.provider, quick.model, "off"]);
    assert.equal(f.classifications(), 0);
  });

  test(`native ${entry.id} sticky authentication loss errors instead of fallback`, async (t) => {
    const f = await fixture(t);
    const virtual = await f.select(entry.provider, entry.id);
    const fake = f.physical.find((p) => p.provider.id === quick.provider);
    assert.ok(fake);
    f.runtime.registerNativeProvider({ ...fake.provider, auth: { apiKey: { name: "Offline denied", resolve: async () => undefined } } });
    await f.runtime.refresh({ allowNetwork: false });
    for (const reason of ["continuation", "retry"] as const) {
      const message = { ...fauxAssistantMessage("success"), provider: quick.provider, model: quick.model, thinkingLevel: "off" as const };
      await assert.rejects(f.runtime.resolveModel(virtual, [message], { reason, thinkingLevel: "high", ...(reason === "retry" ? { failed: message } : {}) }), unavailable);
    }
    assert.equal(f.calls(), 0);
    assert.equal(f.classifications(), 0);
  });
}

test("native branch navigation and reload use branch state, not the abandoned branch", async (t) => {
  const f = await fixture(t);
  const virtual = await f.select("openai-codex", "auto");
  f.respond([fauxAssistantMessage("quick branch")]);
  await f.session.prompt("First turn");
  const leaf = f.manager.getLeafId();
  assert.ok(leaf);
  const quickState = f.state();
  f.choose("deep");
  f.respond([fauxAssistantMessage("deep branch")]);
  await f.session.prompt("Alternate turn");
  assert.notDeepEqual(f.state(), quickState);
  await f.session.navigateTree(leaf, { summarize: false });
  assert.deepEqual(f.state(), quickState);
  await f.session.reload();
  assert.deepEqual(f.state(), quickState);
  const messages = f.session.messages.filter((message) => message.role === "assistant");
  const route = await f.runtime.resolveModel(virtual, messages, { reason: "continuation", thinkingLevel: "high", state: f.state() });
  assert.deepEqual([route.model.provider, route.model.id, route.thinkingLevel], expectedPairs.auto?.quick);
  assert.equal(route.state, f.state());
  await f.remove("openai-codex", "gpt-6.1-terra");
  for (const reason of ["continuation", "retry"] as const) {
    await assert.rejects(f.runtime.resolveModel(virtual, [], { reason, thinkingLevel: "high", state: f.state() }), /sticky target openai-codex\/gpt-6\.1-terra/);
  }
  assert.equal(f.calls(), 2);
});

test("native no-state retry cannot recover an omitted failed identity and retains explicit previous precedence", async (t) => {
  const f = await fixture(t);
  const virtual = await f.select("openai-codex", "auto");
  const older = { ...fauxAssistantMessage("older success"), provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "low" as const };
  const failed = { ...fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
    provider: "openai-codex", model: "gpt-6.1-terra", thinkingLevel: "off" as const };
  await f.remove(failed.provider, failed.model);
  const options = { reason: "retry" as const, thinkingLevel: "high" as const };
  const lostFailure = await f.runtime.resolveModel(virtual, [older], { ...options, failed });
  const routingFailure = await f.runtime.resolveModel(virtual, [older], options);
  assert.deepEqual(lostFailure, routingFailure, "the public router receives no evidence that distinguishes these cases");
  assert.deepEqual([lostFailure.model.provider, lostFailure.model.id, lostFailure.thinkingLevel], [older.provider, older.model, "low"]);
  assert.equal(f.classifications(), 0);
});

test("native available previous remains authoritative over conflicting branch state", async (t) => {
  const f = await fixture(t);
  const virtual = await f.select("openai-codex", "auto");
  const previous = { ...fauxAssistantMessage("previous"), provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "off" as const };
  for (const reason of ["continuation", "retry"] as const) {
    const route = await f.runtime.resolveModel(virtual, [previous], {
      reason, thinkingLevel: "high", state: { provider: "openai-codex", modelId: "gpt-6.1-terra" },
    });
    assert.deepEqual([route.model.provider, route.model.id, route.thinkingLevel], [previous.provider, previous.model, "off"]);
  }
});


test("native repeated user selection of the same physical model appends no duplicate state", async (t) => {
  const f = await fixture(t);
  await f.select("openai-codex", "auto");
  for (const prompt of ["First question", "Second question"]) {
    f.respond([fauxAssistantMessage("quick")]);
    await f.session.prompt(prompt);
  }
  assert.equal(f.states().length, 1);
  assert.equal(f.classifications(), 2);
});
