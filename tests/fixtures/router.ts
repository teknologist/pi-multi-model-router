import { readFile } from "node:fs/promises";
import {
  fauxProvider,
  type Api,
  type ClassifierApi,
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierResult,
  type Model,
  type ModelsClassifierOptions,
  type ModelType,
  type ModelTypeMap,
} from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { parseConfig, type VirtualModelConfig } from "../../src/config.ts";

export const exampleSource = await readFile(new URL("../../examples/config.toml", import.meta.url), "utf8");
export const entries = parseConfig(exampleSource, "examples/config.toml").virtualModels;
export const expectedPairs: Readonly<Record<string, Readonly<Record<string, readonly [string, string, string]>>>> = {
  auto: {
    quick: ["openai-codex", "gpt-6.1-terra", "low"],
    balanced: ["openai-codex", "gpt-6.1-sol", "medium"],
    deep: ["openai-codex", "gpt-6-astra", "medium"],
  },
  "local-ai": {
    quick: ["local-engine", "qwen3.8-27b", "off"],
    balanced: ["local-engine", "qwen3.8-27b", "medium"],
    deep: ["local-engine-2", "GLM-5.3-Flash-EXL3", "high"],
  },
};

export function physical(provider: string, id: string): Model<Api> {
  return fauxProvider({ provider, models: [{ id, reasoning: true }] }).getModel();
}

export function request(entry: VirtualModelConfig, overrides: Partial<ModelRouteRequest> = {}): ModelRouteRequest {
  return {
    model: { ...physical(entry.provider, entry.id), api: "pi-virtual" }, thinkingLevel: "high", reason: "user",
    messages: [{ role: "user", content: "What is 17 + 25?", timestamp: 0 }], ...overrides,
  };
}

export function choiceResult(choice: string): ClassifierResult {
  return {
    api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", timestamp: 0, stopReason: "stop",
    answers: { route: { type: "choice", choice, probabilities: { deep: 0.99, quick: 0.01 }, confidence: 0.01 } },
  };
}

export function registryFixture() {
  const catalog = new Map<string, Model<Api>>();
  for (const entry of entries) {
    for (const route of Object.values(entry.routes)) {
      catalog.set(`${route.provider}/${route.model}`, physical(route.provider, route.model));
    }
  }
  const jev: ClassifierModel<ClassifierApi> = {
    type: "classifier", api: "typesafe-system-one", provider: "typesafe", id: "jev-latest", name: "Jev",
    baseUrl: "https://example.invalid", input: ["text"], contextWindow: 32000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const types: { [K in ModelType]?: ModelTypeMap[K] } = { classifier: jev };
  const calls: { model: ClassifierModel<ClassifierApi>; context: ClassifierContext; options?: ModelsClassifierOptions }[] = [];
  const lookups: string[][] = [];
  const denied = new Set<string>();
  let classify: ModelRegistry["classify"] = async () => choiceResult("quick");
  const registry: Pick<ModelRegistry, "find" | "findOfType" | "hasConfiguredAuth" | "classify"> = {
    find: (provider, id) => catalog.get(`${provider}/${id}`),
    findOfType: (type, provider, id) => {
      lookups.push([type, provider, id]);
      return types[type];
    },
    hasConfiguredAuth: (model) => !denied.has(`${model.provider}/${model.id}`),
    classify: async (model, context, options) => {
      calls.push({ model, context, ...(options ? { options } : {}) });
      return classify(model, context, options);
    },
  };
  return { registry, catalog, denied, calls, lookups, types, setClassify: (fn: ModelRegistry["classify"]) => { classify = fn; } };
}
