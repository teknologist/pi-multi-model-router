import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryModelsStore,
  type AssistantMessage,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionVirtualModel,
  type ModelRoute,
  type ModelRouteReason,
  type ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

test("pinned native SDK prerequisites (no transport)", async (t) => {
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    throw new Error("Unexpected network request in native prerequisite test");
  });
  const dir = await mkdtemp(join(tmpdir(), "pi-router-prerequisites-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await t.test("loads Pi packages at or above the supported minimum 1.5.0", async () => {
    for (const name of ["pi-coding-agent", "pi-ai"]) {
      const manifest: unknown = JSON.parse(await readFile(
        new URL(`../node_modules/@earendil-works/${name}/package.json`, import.meta.url),
        "utf8",
      ));
      assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest);
      assert.ok(typeof manifest.version === "string");
      const [major = 0, minor = 0] = manifest.version.split(".").map(Number);
      assert.ok(major > 1 || (major === 1 && minor >= 5), `${name} ${manifest.version} is below 1.5.0`);
    }
    const levels: Record<ModelThinkingLevel, true> = {
      off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
    };
    assert.equal(Object.keys(levels).length, 7);
  });

  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const faux = fauxProvider({
    models: [{ id: "small", contextWindow: 1000, maxTokens: 100, input: ["text"], reasoning: true }],
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const physical = runtime.getModel("faux", "small");
  assert.ok(physical);
  const keys = [
    { provider: "probe-router", id: "one" },
    { provider: "probe-router", id: "two" },
    { provider: "second-router", id: "three" },
  ];
  let generations = 0;
  let shutdowns = 0;
  const reasons: ModelRouteReason[] = [];
  const route = (request: ModelRouteRequest): ModelRoute => {
    reasons.push(request.reason);
    return {
      model: physical,
      thinkingLevel: request.reason === "user"
        ? "off"
        : request.failed?.thinkingLevel ?? request.previous?.thinkingLevel ?? "medium",
    };
  };
  const factory = (api: ExtensionAPI): void => {
    generations++;
    for (const key of keys) {
      const definition: ExtensionVirtualModel = { ...key, name: key.id, route };
      api.registerVirtualModel(definition);
    }
    api.on("session_shutdown", async () => {
      shutdowns++;
      for (const key of keys) api.unregisterVirtualModel(key.provider, key.id);
    });
  };
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    disabledBuiltinExtensions: ["mcp"],
    extensionFactories: [factory],
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(dir);
  const options = {
    cwd: dir, agentDir: dir, modelRuntime: runtime, resourceLoader: loader,
    settingsManager, sessionManager, tools: [],
  };
  const { session } = await createAgentSession(options);
  t.after(() => session.dispose());

  await t.test("factory registers multiple identities under shared and separate providers", () => {
    for (const key of keys) assert.ok(runtime.getModel(key.provider, key.id));
    assert.equal(generations, 1);
  });

  const one = runtime.getModel("probe-router", "one");
  assert.ok(one);
  await t.test("virtual-only provider is selectable without credentials", async () => {
    await session.setModel(one);
    assert.equal(session.model?.provider, "probe-router");
    assert.equal(session.model?.id, "one");
  });

  await t.test("native resolution accepts all reasons and preserves physical off", async () => {
    const supportedReasons: ModelRouteReason[] = ["user", "continuation", "retry", "direct"];
    for (const reason of supportedReasons) {
      const result = await runtime.resolveModel(one, [], { reason, thinkingLevel: "off" });
      assert.equal(result.model.provider, "faux");
      assert.equal(result.model.id, "small");
      assert.equal(result.thinkingLevel, reason === "user" ? "off" : "medium");
    }
    assert.deepEqual(reasons, supportedReasons);
  });

  const message: AssistantMessage = {
    ...fauxAssistantMessage("ok"),
    provider: physical.provider, api: physical.api, model: physical.id, thinkingLevel: "off",
  };
  await t.test("native previous and failed physical responses carry thinking levels", async () => {
    sessionManager.appendMessage(message);
    const continued = await runtime.resolveModel(one, [message], {
      reason: "continuation", thinkingLevel: "medium",
    });
    assert.equal(continued.thinkingLevel, "off");
    const failed: AssistantMessage = { ...message, stopReason: "error", thinkingLevel: "low" };
    const retried = await runtime.resolveModel(one, [message], {
      reason: "retry", thinkingLevel: "medium", failed,
    });
    assert.equal(retried.thinkingLevel, "low");
  });

  await t.test("shutdown cleanup and reload preserve entries and selected identity", async () => {
    await session.reload();
    assert.equal(shutdowns, 1);
    assert.equal(generations, 2);
    for (const key of keys) assert.ok(runtime.getModel(key.provider, key.id));
    assert.equal(session.model?.provider, "probe-router");
    assert.equal(session.model?.id, "one");
  });

  await t.test("same-process SDK reconstruction restores virtual selection after physical response", async () => {
    await runtime.refresh({ allowNetwork: false });
    const resumed = await createAgentSession(options);
    try {
      assert.equal(resumed.session.model?.provider, "probe-router");
      assert.equal(resumed.session.model?.id, "one");
    } finally {
      resumed.session.dispose();
    }
  });

  await t.test("native registration rejects a physical identity collision", () => {
    assert.throws(() => runtime.registerVirtualModel({
      provider: "faux", id: "small", name: "conflict", route: () => ({ model: physical, thinkingLevel: "off" }),
    }), /conflicts with a physical model/);
  });

  await t.test("no classifier, physical transport, or fetch runs", () => {
    assert.equal(faux.state.callCount, 0);
    assert.equal(fetchCalls, 0);
  });
});
