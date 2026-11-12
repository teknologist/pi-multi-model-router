import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fauxProvider, InMemoryModelsStore, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export function isolatedEnvironment(dir: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir, PI_CODING_AGENT_DIR: dir, NO_COLOR: "1" };
}

export async function configure(dir: string, source: string): Promise<void> {
  const path = join(dir, "extensions", "pi-multi-model-router", "config.toml");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
}

export async function nativeFixture(dir: string, options: {
  entrypoint?: string; router?: boolean; classifierAuth?: boolean; sessionFile?: string; persist?: boolean;
  customTools?: ToolDefinition[];
} = {}) {
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false,
  });
  const definitions = [
    ["control", ["default-write", "default-read"]],
    ["openai-codex", ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"]],
    ["local-engine", ["qwen3.8-27b"]],
    ["local-engine-2", ["GLM-5.3-Flash-EXL3"]],
  ] as const;
  const physical = definitions.map(([provider, ids]) => fauxProvider({
    provider, models: ids.map((id) => ({ id, reasoning: true })),
  }));
  for (const fake of physical) runtime.registerNativeProvider(fake.provider);
  await runtime.refresh({ allowNetwork: false });
  if (options.classifierAuth !== false) await runtime.setRuntimeApiKey("typesafe", "offline-dummy-typesafe");
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "control", defaultModel: options.sessionFile ? "default-read" : "default-write",
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false }, images: { autoResize: false },
  });
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: dir, settingsManager, modelRuntime: runtime,
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      disabledBuiltinExtensions: ["mcp"], systemPrompt: "SYSTEM_PRIVATE",
      additionalExtensionPaths: options.router === false ? [] : [options.entrypoint ?? resolve("index.ts")],
    },
  });
  assert.deepEqual(services.diagnostics, []);
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const manager = options.sessionFile ? SessionManager.open(options.sessionFile, join(dir, "sessions"))
    : options.persist ? SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory(dir);
  const { session } = await createAgentSessionFromServices({
    services, sessionManager: manager, tools: options.customTools?.map((tool) => tool.name) ?? [],
    ...(options.customTools ? { customTools: options.customTools } : {}),
  });
  await session.bindExtensions({});
  const providerCalls: [string, string, string | undefined][] = [];
  function respond(steps: FauxResponseStep[]) {
    for (const fake of physical) fake.setResponses(steps.map((step) => (context, options, state, model) => {
      providerCalls.push([model.provider, model.id, options?.reasoning]);
      return typeof step === "function" ? step(context, options, state, model) : step;
    }));
  }
  function calls() { return physical.reduce((sum, fake) => sum + fake.state.callCount, 0); }
  function dispatched() {
    return session.messages.flatMap((message) => message.role === "assistant"
      ? [[message.provider, message.model, message.thinkingLevel]] : []);
  }
  async function select(provider: string, id: string) {
    const model = runtime.getModel(provider, id);
    assert.ok(model, `${provider}/${id} must exist`);
    await session.setModel(model);
    return model;
  }
  return { runtime, session, manager, services, physical, respond, calls, providerCalls, dispatched, select };
}
