import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ExtensionRunner, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionError, type ExtensionVirtualModel,
} from "@earendil-works/pi-coding-agent";
import { stringify } from "smol-toml";
import extension from "../index.ts";
import { getConfigPath } from "../src/config.ts";
import { entries, exampleSource } from "./fixtures/router.ts";

async function fixture(t: TestContext, source: string | null) {
  const dir = await mkdtemp(join(tmpdir(), "pi-router-extension-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    throw new Error("Unexpected network request in extension lifecycle test");
  });
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
  const path = getConfigPath(dir);
  async function configure(value: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  }
  if (source !== null) await configure(source);
  const before = await readdir(dir, { recursive: true });
  const registered: ExtensionVirtualModel[] = [];
  const unregistered: string[][] = [];
  const factory = async (api: ExtensionAPI): Promise<void> => {
    const register = api.registerVirtualModel;
    t.mock.method(api, "registerVirtualModel", (definition: ExtensionVirtualModel) => {
      registered.push(definition);
      register(definition);
    });
    const unregister = api.unregisterVirtualModel;
    t.mock.method(api, "unregisterVirtualModel", (provider: string, id: string) => {
      unregistered.push([provider, id]);
      unregister(provider, id);
    });
    for (const method of ["setModel", "registerProvider"] as const) {
      t.mock.method(api, method, () => { throw new Error(`Forbidden extension call: ${method}`); });
    }
    await extension(api);
  };
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    disabledBuiltinExtensions: ["mcp"], extensionFactories: [factory],
  });
  await loader.reload();
  assert.deepEqual(await readdir(dir, { recursive: true }), before, "factory must not create configuration or state files");
  if (source !== null) assert.equal(await readFile(path, "utf8"), source);
  t.after(() => { assert.equal(fetchCalls, 0); });
  async function start() {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "control", models: [{ id: "physical", reasoning: true }] });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const physical = runtime.getModel("control", "physical");
    assert.ok(physical);
    const { session } = await createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime: runtime, resourceLoader: loader,
      settingsManager, sessionManager: SessionManager.inMemory(dir), model: physical, tools: [],
    });
    t.after(() => session.dispose());
    return { runtime, session, faux, physical };
  }
  return { dir, path, loader, registered, unregistered, diagnostics, configure, start };
}

test("factory queues exactly both example identities before session_start without physical credentials", async (t) => {
  const f = await fixture(t, exampleSource);
  assert.deepEqual(f.loader.getExtensions().errors, []);
  assert.deepEqual(f.registered.map(({ provider, id, name }) => [provider, id, name]), [
    ["openai-codex", "auto", "Auto"], ["router", "local-ai", "local-ai"],
  ]);
  const { runtime, session, faux } = await f.start();
  assert.equal(session.model?.provider, "control", "factory must not force a model change");
  for (const entry of entries) {
    const virtual = runtime.getModel(entry.provider, entry.id);
    assert.ok(virtual);
    assert.equal(virtual.api, "pi-virtual");
  }
  const local = runtime.getModel("router", "local-ai");
  assert.ok(local);
  await session.setModel(local);
  assert.equal(session.model?.provider, "router");
  assert.equal(session.model?.id, "local-ai");
  assert.equal(faux.state.callCount, 0);
});

test("factory supports two virtual IDs under one provider", async (t) => {
  const source = exampleSource.replace('provider = "router"\nid = "local-ai"', 'provider = "openai-codex"\nid = "local-ai"');
  const f = await fixture(t, source);
  assert.deepEqual(f.loader.getExtensions().errors, []);
  const { runtime } = await f.start();
  assert.ok(runtime.getModel("openai-codex", "auto"));
  assert.ok(runtime.getModel("openai-codex", "local-ai"));
  assert.equal(f.registered.length, 2);
});

test("missing configuration emits an actionable diagnostic and registers nothing without writing", async (t) => {
  const f = await fixture(t, null);
  assert.deepEqual(f.loader.getExtensions().errors, []);
  assert.equal(f.registered.length, 0);
  assert.equal(f.diagnostics.length, 1);
  const diagnostic = String(f.diagnostics[0]?.[0]);
  assert.ok(diagnostic.includes(f.path));
  assert.match(diagnostic, /examples\/config\.toml/);
  assert.match(diagnostic, /copy/i);
  assert.deepEqual(await readdir(f.dir), []);
});

const quick = { model: "small", thinking_level: "off", description: "Simple work." };
const routing = { fallback: "quick", quick };
const valid = { provider: "physical", id: "auto", name: "Auto", routing };
const invalid: { name: string; source: string }[] = [];
function invalidDocument(name: string, document: unknown) { invalid.push({ name, source: stringify(document) }); }
for (const source of ["[", 'name = "unterminated', "a = 1\na = 2", '"__proto__" = {}', '"constructor" = {}']) {
  invalid.push({ name: `TOML ${JSON.stringify(source)}`, source });
}
for (const value of [undefined, [], {}, "auto", [42], [[]], [{}]]) {
  invalidDocument(`entry list ${JSON.stringify(value)}`, value === undefined ? {} : { virtual_models: value });
}
for (const field of ["provider", "id", "name", "routing"]) {
  for (const value of [undefined, "", " \t\n ", 12, true, [], {}]) {
    const entry: Record<string, unknown> = { ...valid, [field]: value };
    if (value === undefined) delete entry[field];
    invalidDocument(`entry ${field} ${JSON.stringify(value)}`, { virtual_models: [entry] });
  }
}
for (const value of [undefined, "", " \t", 1, true, [], {}, "missing", "toString"]) {
  const routes: Record<string, unknown> = { ...routing, fallback: value };
  if (value === undefined) delete routes.fallback;
  invalidDocument(`fallback ${JSON.stringify(value)}`, { virtual_models: [{ ...valid, routing: routes }] });
}
for (const field of ["provider", "model", "description", "thinking_level"]) {
  for (const value of [undefined, "", " \t", 1, true, [], {}]) {
    if (field === "provider" && value === undefined) continue;
    const route: Record<string, unknown> = { ...quick, [field]: value };
    if (value === undefined) delete route[field];
    invalidDocument(`route ${field} ${JSON.stringify(value)}`, { virtual_models: [{ ...valid, routing: { ...routing, quick: route } }] });
  }
}
for (const level of ["auto", "MEDIUM", "medium "]) {
  invalidDocument(`unsupported thinking level ${JSON.stringify(level)}`, { virtual_models: [{ ...valid, routing: { ...routing, quick: { ...quick, thinking_level: level } } }] });
}
invalidDocument("date routing", { virtual_models: [{ ...valid, routing: new Date("2026-11-12T00:00:00Z") }] });
invalidDocument("empty route", { virtual_models: [{ ...valid, routing: { ...routing, quick: {} } }] });
invalidDocument("no routes", { virtual_models: [{ ...valid, routing: { fallback: "quick" } }] });
for (const key of ["", " \t"]) {
  invalidDocument(`blank route ${JSON.stringify(key)}`, { virtual_models: [{ ...valid, routing: { ...routing, [key]: quick } }] });
}
for (const key of ["virtual_model", "routing"]) {
  for (const mixed of [true, false]) invalidDocument(`legacy ${key}, mixed ${mixed}`, { [key]: {}, ...(mixed ? { virtual_models: [valid] } : {}) });
}
invalidDocument("unknown root", { virtual_models: [valid], extra: true });
invalidDocument("unknown entry", { virtual_models: [{ ...valid, extra: true }] });
invalidDocument("unknown route", { virtual_models: [{ ...valid, routing: { ...routing, quick: { ...quick, extra: true } } }] });
invalidDocument("scalar route", { virtual_models: [{ ...valid, routing: { ...routing, quick: "small" } }] });
invalidDocument("array route", { virtual_models: [{ ...valid, routing: { ...routing, quick: [] } }] });
invalidDocument("unknown routing scalar", { virtual_models: [{ ...valid, routing: { ...routing, extra: true } }] });
invalidDocument("duplicate identities", { virtual_models: [valid, valid] });
invalidDocument("invalid second entry", { virtual_models: [valid, { ...valid, id: "second", routing: {} }] });
for (const kind of ["self", "forward", "backward", "cycle"]) {
  const first = { ...valid, id: "first" };
  const second = { ...valid, provider: "other", id: "second" };
  const toFirst = { ...quick, provider: "physical", model: "first" };
  const toSecond = { ...quick, provider: "other", model: "second" };
  invalidDocument(`${kind} virtual reference`, { virtual_models: kind === "self"
    ? [{ ...first, routing: { ...routing, quick: { ...quick, model: "first" } } }]
    : [{ ...first, routing: { ...routing, quick: kind === "backward" ? quick : toSecond } },
      { ...second, routing: { ...routing, quick: kind === "forward" ? quick : toFirst } }] });
}
for (const { name, source } of invalid) {
  test(`factory rejects ${name} before any registration`, async (t) => {
    const f = await fixture(t, source);
    assert.equal(f.registered.length, 0);
    assert.equal(f.unregistered.length, 0);
    assert.equal(f.loader.getExtensions().errors.length, 1);
    assert.ok(f.loader.getExtensions().errors[0]?.error.includes(f.path));
  });
}

test("native routes connect each entry's fallback and physical provider override", async (t) => {
  const f = await fixture(t, exampleSource);
  const { runtime, session, faux } = await f.start();
  const targets = [
    fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6.1-sol", reasoning: true }] }),
    fauxProvider({ provider: "local-engine", models: [{ id: "qwen3.8-27b", reasoning: true }] }),
  ];
  for (const target of targets) runtime.registerNativeProvider(target.provider);
  await runtime.refresh({ allowNetwork: false });
  for (const entry of entries) {
    const virtual = runtime.getModel(entry.provider, entry.id);
    assert.ok(virtual);
    await session.setModel(virtual);
    const route = await runtime.resolveModel(virtual, [], { reason: "direct", thinkingLevel: "off" });
    const target = entry.id === "auto" ? ["openai-codex", "gpt-6.1-sol"] : ["local-engine", "qwen3.8-27b"];
    assert.deepEqual([route.model.provider, route.model.id, route.thinkingLevel], [...target, "medium"]);
    assert.equal(session.model?.id, entry.id);
    assert.equal(route.state, undefined);
  }
  assert.equal(faux.state.callCount, 0);
  for (const target of targets) assert.equal(target.state.callCount, 0);
});

test("native reload removes stale keys, refreshes entries, and preserves the selected virtual identity", async (t) => {
  const f = await fixture(t, exampleSource);
  const { runtime, session, physical } = await f.start();
  runtime.registerVirtualModel({ provider: "unrelated", id: "keep", name: "Keep", route: () => ({ model: physical, thinkingLevel: "off" }) });
  const selected = runtime.getModel("router", "local-ai");
  assert.ok(selected);
  await session.setModel(selected);
  await session.reload();
  assert.deepEqual(f.unregistered, [["openai-codex", "auto"], ["router", "local-ai"]]);
  assert.equal(f.registered.length, 4);
  assert.equal(session.model?.provider, "router");
  assert.equal(session.model?.id, "local-ai");
  assert.ok(runtime.getModel("openai-codex", "auto"));
  assert.ok(runtime.getModel("unrelated", "keep"));
  const localOnly = exampleSource.slice(exampleSource.indexOf("[[virtual_models]]", 1)).replace('name = "local-ai"', 'name = "Updated local"');
  await f.configure(localOnly);
  await session.reload();
  assert.equal(f.registered.length, 5);
  assert.equal(runtime.getModel("openai-codex", "auto"), undefined);
  assert.equal(runtime.getModel("router", "local-ai")?.name, "Updated local");
  assert.equal(session.model?.provider, "router");
  assert.equal(session.model?.id, "local-ai");
  assert.ok(runtime.getModel("unrelated", "keep"));
  await f.configure("[");
  await session.reload();
  assert.equal(runtime.getModel("router", "local-ai"), undefined);
  assert.equal(f.registered.length, 5, "invalid reload must not register a partial entry");
  assert.ok(runtime.getModel("unrelated", "keep"));
  assert.equal(f.loader.getExtensions().errors.length, 1);
});

test("shutdown unregisters only this factory's keys and is idempotent under exclusive ownership", async (t) => {
  const f = await fixture(t, exampleSource);
  const { runtime, session, physical } = await f.start();
  runtime.registerVirtualModel({ provider: "router", id: "unrelated", name: "Unrelated", route: () => ({ model: physical, thinkingLevel: "off" }) });
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(f.unregistered, [["openai-codex", "auto"], ["router", "local-ai"]]);
  assert.equal(runtime.getModel("openai-codex", "auto"), undefined);
  assert.equal(runtime.getModel("router", "local-ai"), undefined);
  assert.ok(runtime.getModel("router", "unrelated"));
  assert.equal(runtime.getModel("control", "physical"), physical);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(f.unregistered.length, 2);
});

test("native physical collision reports the entry error and keeps the other valid registration", async (t) => {
  const f = await fixture(t, null);
  const { runtime, session, physical } = await f.start();
  const errors: ExtensionError[] = [];
  const emitError = ExtensionRunner.prototype.emitError;
  t.mock.method(ExtensionRunner.prototype, "emitError", function (this: ExtensionRunner, error: ExtensionError) {
    errors.push(error);
    emitError.call(this, error);
  });
  const collided = fauxProvider({ provider: "openai-codex", models: [{ id: "auto", reasoning: true }] });
  runtime.registerNativeProvider(collided.provider);
  await runtime.refresh({ allowNetwork: false });
  assert.notEqual(runtime.getModel("openai-codex", "auto")?.api, "pi-virtual");
  assert.ok(runtime.getPhysicalModel("openai-codex", "auto"));
  await f.configure(exampleSource);
  await session.reload();
  assert.equal(f.registered.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.event, "register_virtual_model");
  assert.match(errors[0]?.error ?? "", /openai-codex\/auto.*conflicts with a physical model/);
  assert.notEqual(runtime.getModel("openai-codex", "auto")?.api, "pi-virtual");
  assert.equal(runtime.getModel("router", "local-ai")?.api, "pi-virtual");
  assert.equal(session.model?.id, physical.id, "partial registration must not force selection");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.ok(runtime.getModel("openai-codex", "auto"), "cleanup must preserve the colliding physical model");
  assert.equal(runtime.getModel("router", "local-ai"), undefined);
  assert.equal(collided.state.callCount, 0);
});
