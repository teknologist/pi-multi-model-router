import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, TomlError } from "smol-toml";

export interface RouteConfig {
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly description: string;
}

export interface VirtualModelConfig {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly fallback: string;
  readonly routes: Readonly<Record<string, RouteConfig>>;
}

export interface RouterConfig {
  readonly virtualModels: readonly VirtualModelConfig[];
}

export type ConfigLoadResult =
  | { status: "loaded"; path: string; config: RouterConfig }
  | { status: "missing"; path: string; config: RouterConfig; diagnostic: string };

export class ConfigError extends Error {
  readonly configPath: string;
  readonly context: string;

  constructor(configPath: string, context: string, problem: string) {
    super(`${configPath}: ${context}: ${problem}`);
    this.name = "ConfigError";
    this.configPath = configPath;
    this.context = context;
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function table(value: unknown, path: string, context: string): Record<string, unknown> {
  if (!isTable(value)) throw new ConfigError(path, context, "Expected a table.");
  return value;
}

function text(value: unknown, path: string, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(path, context, "Expected a nonempty string.");
  }
  return value;
}

function knownFields(value: Record<string, unknown>, allowed: readonly string[], path: string, context: string): void {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      throw new ConfigError(path, `${context}.${field}`, `Unknown field ${JSON.stringify(field)}. Remove it.`);
    }
  }
}

function thinkingLevel(value: unknown, path: string, context: string): ModelThinkingLevel {
  switch (value) {
    case "off": case "minimal": case "low": case "medium": case "high": case "xhigh": case "max":
      return value;
    default:
      throw new ConfigError(path, context, "Expected a thinking level: off, minimal, low, medium, high, xhigh, or max.");
  }
}

function parseEntry(value: unknown, index: number, path: string): VirtualModelConfig {
  const context = `virtual_models[${index}]`;
  const entry = table(value, path, context);
  knownFields(entry, ["provider", "id", "name", "routing"], path, context);
  const provider = text(entry.provider, path, `${context}.provider`);
  const id = text(entry.id, path, `${context}.id`);
  const name = text(entry.name, path, `${context}.name`);
  const routing = table(entry.routing, path, `${context}.routing`);
  const fallback = text(routing.fallback, path, `${context}.routing.fallback`);
  const routes = Object.fromEntries(
    Object.entries(routing).filter(([key]) => key !== "fallback").map(([key, raw]): [string, RouteConfig] => {
      const routeContext = `${context}.routing[${JSON.stringify(key)}]`;
      if (key.trim().length === 0) {
        throw new ConfigError(path, routeContext, "Expected a nonempty route name.");
      }
      const route = table(raw, path, routeContext);
      knownFields(route, ["provider", "model", "thinking_level", "description"], path, routeContext);
      return [key, {
        provider: Object.hasOwn(route, "provider") ? text(route.provider, path, `${routeContext}.provider`) : provider,
        model: text(route.model, path, `${routeContext}.model`),
        thinkingLevel: thinkingLevel(route.thinking_level, path, `${routeContext}.thinking_level`),
        description: text(route.description, path, `${routeContext}.description`),
      }];
    }),
  );
  if (Object.keys(routes).length === 0) {
    throw new ConfigError(path, `${context}.routing`, "Configure at least one route table.");
  }
  if (!Object.hasOwn(routes, fallback)) {
    throw new ConfigError(path, `${context}.routing.fallback`, "Fallback must name a configured route.");
  }
  return { provider, id, name, fallback, routes };
}

export function parseConfig(source: string, configPath: string): RouterConfig {
  let parsed: unknown;
  try {
    parsed = parse(source, { unsafeKeyBehaviour: "throw" });
  } catch (error) {
    const location = error instanceof TomlError ? ` at line ${error.line}, column ${error.column}` : "";
    throw new ConfigError(configPath, "TOML", `Invalid TOML${location}. Correct the configuration syntax and keys.`);
  }
  const root = table(parsed, configPath, "config");
  for (const legacy of ["virtual_model", "routing"]) {
    if (Object.hasOwn(root, legacy)) {
      throw new ConfigError(configPath, legacy,
        `Legacy schema is not supported. Remove [${legacy}] and use [[virtual_models]] with per-entry routing tables.`);
    }
  }
  knownFields(root, ["virtual_models"], configPath, "config");
  if (!Array.isArray(root.virtual_models) || root.virtual_models.length === 0) {
    throw new ConfigError(configPath, "virtual_models", "Expected a nonempty array of [[virtual_models]] tables.");
  }
  const rawEntries: readonly unknown[] = root.virtual_models;
  const virtualModels = rawEntries.map((value, index) => parseEntry(value, index, configPath));
  const identities = new Map<string, Set<string>>();
  for (const [index, entry] of virtualModels.entries()) {
    const ids = identities.get(entry.provider) ?? new Set<string>();
    if (ids.has(entry.id)) {
      throw new ConfigError(configPath, `virtual_models[${index}].id`, `Duplicate virtual model ${entry.provider}/${entry.id}.`);
    }
    ids.add(entry.id);
    identities.set(entry.provider, ids);
  }
  for (const [index, entry] of virtualModels.entries()) {
    for (const [key, route] of Object.entries(entry.routes)) {
      if (identities.get(route.provider)?.has(route.model)) {
        throw new ConfigError(configPath, `virtual_models[${index}].routing[${JSON.stringify(key)}]`,
          `Route targets configured virtual model ${route.provider}/${route.model}. Use a physical model instead.`);
      }
    }
  }
  return { virtualModels };
}

export function getConfigPath(agentDir?: string): string {
  return join(agentDir ?? getAgentDir(),
    "extensions", "pi-multi-model-router", "config.toml");
}

export async function loadConfig(agentDir?: string): Promise<ConfigLoadResult> {
  const path = getConfigPath(agentDir);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code : "UNKNOWN";
    if (code === "ENOENT") {
      return {
        status: "missing", path, config: { virtualModels: [] },
        diagnostic: `No virtual models are configured. Copy examples/config.toml to ${path} and edit its [[virtual_models]] entries.`,
      };
    }
    throw new ConfigError(path, "file", `Cannot read configuration (${code}). Check the file path and read permissions.`);
  }
  return { status: "loaded", path, config: parseConfig(source, path) };
}
