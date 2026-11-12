import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { stringify } from "smol-toml";
import {
  ConfigError,
  getConfigPath,
  loadConfig,
  parseConfig,
  type RouterConfig,
} from "../src/config.ts";

const configPath = "/isolated/agent/extensions/pi-multi-model-router/config.toml";
const quick = { model: "small", thinking_level: "off", description: "Simple work." };
const routing = { fallback: "quick", quick };
const entry = { provider: "physical", id: "auto", name: "Auto", routing };
const sourceFor = (patch: Record<string, unknown> = {}): string =>
  stringify({ virtual_models: [{ ...entry, ...patch }] });

function rejectsConfig(source: string, context: RegExp, problem: RegExp): void {
  assert.throws(() => parseConfig(source, configPath), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.configPath, configPath);
    assert.match(error.context, context);
    assert.ok(error.message.includes(configPath));
    assert.match(error.message, problem);
    return true;
  });
}

test("complete example preserves both identities, all physical targets, and thinking levels", async () => {
  const source = await readFile(new URL("../examples/config.toml", import.meta.url), "utf8");
  assert.deepEqual(parseConfig(source, configPath), {
    virtualModels: [
      {
        provider: "openai-codex", id: "auto", name: "Auto", fallback: "balanced",
        routes: {
          quick: {
            provider: "openai-codex", model: "gpt-6.1-terra", thinkingLevel: "low",
            description: "Simple questions and small, clear tasks.",
          },
          balanced: {
            provider: "openai-codex", model: "gpt-6.1-sol", thinkingLevel: "medium",
            description: "General tasks that need moderate reasoning.",
          },
          deep: {
            provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "medium",
            description: "Complex tasks that need careful reasoning.",
          },
        },
      },
      {
        provider: "router", id: "local-ai", name: "local-ai", fallback: "balanced",
        routes: {
          quick: {
            provider: "local-engine", model: "qwen3.8-27b", thinkingLevel: "off",
            description: "Simple questions and small, clear tasks.",
          },
          balanced: {
            provider: "local-engine", model: "qwen3.8-27b", thinkingLevel: "medium",
            description: "General tasks that need moderate reasoning.",
          },
          deep: {
            provider: "local-engine-2", model: "GLM-5.3-Flash-EXL3", thinkingLevel: "high",
            description: "Complex tasks that need careful reasoning.",
          },
        },
      },
    ],
  });
});

test("route providers inherit only when omitted; explicit physical overrides remain separate", () => {
  const config = parseConfig(sourceFor({
    routing: { fallback: "custom", custom: quick, remote: { ...quick, provider: "remote" } },
  }), configPath);
  assert.equal(config.virtualModels[0]?.routes.custom?.provider, "physical");
  assert.equal(config.virtualModels[0]?.routes.remote?.provider, "remote");
  assert.equal(config.virtualModels[0]?.fallback, "custom");
});

test("multiple virtual IDs can share a provider, and the same ID can use separate providers", () => {
  const config = parseConfig(stringify({ virtual_models: [
    entry, { ...entry, id: "second" }, { ...entry, provider: "other" },
  ] }), configPath);
  assert.deepEqual(config.virtualModels.map(({ provider, id }) => [provider, id]), [
    ["physical", "auto"], ["physical", "second"], ["other", "auto"],
  ]);
});

const thinkingLevels: Record<ModelThinkingLevel, true> = {
  off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
};
for (const level of Object.keys(thinkingLevels)) {
  test(`accepts native thinking level ${level}`, () => {
    const config = parseConfig(sourceFor({
      routing: { ...routing, quick: { ...quick, thinking_level: level } },
    }), configPath);
    assert.equal(config.virtualModels[0]?.routes.quick?.thinkingLevel, level);
  });
}

const invalidDocuments: { name: string; value: unknown; context: RegExp; problem: RegExp }[] = [
  { name: "empty document", value: {}, context: /virtual_models/, problem: /nonempty array/ },
  { name: "empty entry list", value: { virtual_models: [] }, context: /virtual_models/, problem: /nonempty array/ },
  { name: "entry list as table", value: { virtual_models: entry }, context: /virtual_models/, problem: /nonempty array/ },
  { name: "entry list as string", value: { virtual_models: "auto" }, context: /virtual_models/, problem: /nonempty array/ },
  { name: "entry as scalar", value: { virtual_models: [42] }, context: /virtual_models\[0\]/, problem: /table/ },
  { name: "entry as array", value: { virtual_models: [[]] }, context: /virtual_models\[0\]/, problem: /table/ },
  { name: "empty entry", value: { virtual_models: [{}] }, context: /virtual_models\[0\]\.provider/, problem: /nonempty string/ },
  { name: "unknown root field", value: { virtual_models: [entry], extra: true }, context: /extra/, problem: /Unknown field/ },
  { name: "unknown entry field", value: { virtual_models: [{ ...entry, extra: true }] }, context: /extra/, problem: /Unknown field/ },
  { name: "missing routing", value: { virtual_models: [{ provider: "p", id: "a", name: "A" }] }, context: /routing/, problem: /table/ },
  { name: "scalar routing", value: { virtual_models: [{ ...entry, routing: true }] }, context: /routing/, problem: /table/ },
  { name: "array routing", value: { virtual_models: [{ ...entry, routing: [] }] }, context: /routing/, problem: /table/ },
  { name: "date routing", value: { virtual_models: [{ ...entry, routing: new Date("2026-11-12T00:00:00Z") }] }, context: /routing/, problem: /table/ },
  { name: "empty routing", value: { virtual_models: [{ ...entry, routing: {} }] }, context: /fallback/, problem: /nonempty string/ },
  { name: "missing fallback", value: { virtual_models: [{ ...entry, routing: { quick } }] }, context: /fallback/, problem: /nonempty string/ },
  { name: "fallback without routes", value: { virtual_models: [{ ...entry, routing: { fallback: "quick" } }] }, context: /routing/, problem: /at least one route/ },
  { name: "nonexistent fallback", value: { virtual_models: [{ ...entry, routing: { ...routing, fallback: "missing" } }] }, context: /fallback/, problem: /configured route/ },
  { name: "inherited-object fallback", value: { virtual_models: [{ ...entry, routing: { ...routing, fallback: "toString" } }] }, context: /fallback/, problem: /configured route/ },
  { name: "empty route", value: { virtual_models: [{ ...entry, routing: { ...routing, quick: {} } }] }, context: /quick.*model/, problem: /nonempty string/ },
  { name: "scalar route", value: { virtual_models: [{ ...entry, routing: { ...routing, quick: "small" } }] }, context: /quick/, problem: /table/ },
  { name: "array route", value: { virtual_models: [{ ...entry, routing: { ...routing, quick: [] } }] }, context: /quick/, problem: /table/ },
  { name: "unknown routing scalar", value: { virtual_models: [{ ...entry, routing: { ...routing, extra: true } }] }, context: /extra/, problem: /table/ },
  { name: "unknown route field", value: { virtual_models: [{ ...entry, routing: { ...routing, quick: { ...quick, extra: true } } }] }, context: /extra/, problem: /Unknown field/ },
  { name: "empty route name", value: { virtual_models: [{ ...entry, routing: { fallback: "quick", quick, "": quick } }] }, context: /routing/, problem: /route name/ },
  { name: "blank route name", value: { virtual_models: [{ ...entry, routing: { ...routing, " \t ": quick } }] }, context: /routing/, problem: /route name/ },
];
for (const fixture of invalidDocuments) {
  test(`rejects ${fixture.name} with file and field context`, () => {
    rejectsConfig(stringify(fixture.value), fixture.context, fixture.problem);
  });
}

for (const field of ["provider", "id", "name"]) {
  for (const value of ["", " \t\n ", 12, true, [], {}]) {
    test(`rejects malformed entry ${field}: ${JSON.stringify(value)}`, () => {
      rejectsConfig(sourceFor({ [field]: value }), new RegExp(`\\.${field}$`), /nonempty string/);
    });
  }
  test(`rejects missing entry ${field}`, () => {
    const fields: Record<string, unknown> = { ...entry };
    delete fields[field];
    rejectsConfig(stringify({ virtual_models: [fields] }), new RegExp(`\\.${field}$`), /nonempty string/);
  });
}
for (const field of ["provider", "model", "description"]) {
  for (const value of ["", " \t\n ", 12, true, [], {}]) {
    test(`rejects malformed route ${field}: ${JSON.stringify(value)}`, () => {
      rejectsConfig(sourceFor({ routing: { ...routing, quick: { ...quick, [field]: value } } }),
        new RegExp(`quick.*\\.${field}$`), /nonempty string/);
    });
  }
}
for (const field of ["model", "description", "thinking_level"]) {
  test(`rejects missing route ${field}`, () => {
    const fields: Record<string, unknown> = { ...quick };
    delete fields[field];
    rejectsConfig(sourceFor({ routing: { ...routing, quick: fields } }),
      new RegExp(`quick.*\\.${field}$`), field === "thinking_level" ? /thinking level/ : /nonempty string/);
  });
}
for (const value of ["", " \t ", 42, true, [], {}]) {
  test(`rejects malformed fallback ${JSON.stringify(value)}`, () => {
    rejectsConfig(sourceFor({ routing: { ...routing, fallback: value } }), /fallback$/, /nonempty string/);
  });
}
for (const value of ["", " ", "auto", "MEDIUM", "medium ", 1, true, [], {}]) {
  test(`rejects invalid thinking level ${JSON.stringify(value)}`, () => {
    rejectsConfig(sourceFor({ routing: { ...routing, quick: { ...quick, thinking_level: value } } }),
      /quick.*thinking_level$/, /thinking level.*off.*minimal.*low.*medium.*high.*xhigh.*max/);
  });
}

for (const field of ["virtual_model", "routing"]) {
  for (const mixed of [false, true]) {
    test(`rejects legacy ${field}, mixed=${mixed}, with migration guidance`, () => {
      rejectsConfig(stringify({ [field]: {}, ...(mixed ? { virtual_models: [entry] } : {}) }),
        new RegExp(field), /legacy.*\[\[virtual_models\]\]/i);
    });
  }
}

test("rejects duplicate provider/id before returning any entries", () => {
  let parsed: RouterConfig | undefined;
  assert.throws(() => {
    parsed = parseConfig(stringify({ virtual_models: [entry, entry] }), configPath);
  }, /Duplicate.*physical\/auto/);
  assert.equal(parsed, undefined);
});

test("does not confuse distinct provider/id pairs containing slashes", () => {
  const config = parseConfig(stringify({ virtual_models: [
    { ...entry, provider: "a/b", id: "c" }, { ...entry, provider: "a", id: "b/c" },
  ] }), configPath);
  assert.equal(config.virtualModels.length, 2);
});

for (const kind of ["self", "forward", "backward", "cycle"]) {
  test(`rejects ${kind} virtual references`, () => {
    const first = { ...entry, id: "first" };
    const second = { ...entry, provider: "other", id: "second" };
    const toFirst = { ...quick, provider: "physical", model: "first" };
    const toSecond = { ...quick, provider: "other", model: "second" };
    const values = kind === "self"
      ? [{ ...first, routing: { ...routing, quick: { ...quick, model: "first" } } }]
      : [
        { ...first, routing: { ...routing, quick: kind === "backward" ? quick : toSecond } },
        { ...second, routing: { ...routing, quick: kind === "forward" ? quick : toFirst } },
      ];
    rejectsConfig(stringify({ virtual_models: values }), /routing.*quick/, /configured virtual model/);
  });
}

test("one invalid later entry prevents a usable partial configuration", () => {
  let parsed: RouterConfig | undefined;
  assert.throws(() => {
    parsed = parseConfig(stringify({ virtual_models: [entry, { ...entry, id: "second", routing: {} }] }), configPath);
  }, /virtual_models\[1\].*fallback/);
  assert.equal(parsed, undefined);
});

for (const source of ["[", 'name = "unterminated', "a = 1\na = 2", '"__proto__" = {}', '"constructor" = {}']) {
  test(`rejects malformed or unsafe TOML ${JSON.stringify(source)}`, () => {
    rejectsConfig(source, /^TOML$/, /Invalid TOML.*line \d+.*column \d+/);
  });
}

test("TOML diagnostics do not include source snippets or a parser error cause", () => {
  const source = 'sample = "unterminated';
  assert.throws(() => parseConfig(source, configPath), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.ok(!error.message.includes("unterminated"));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("config path uses only the explicit agent directory, environment, or native default", (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  process.env.PI_CODING_AGENT_DIR = "/isolated/profile";
  assert.equal(getConfigPath(), "/isolated/profile/extensions/pi-multi-model-router/config.toml");
  assert.equal(getConfigPath("/isolated/override"), "/isolated/override/extensions/pi-multi-model-router/config.toml");
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(getConfigPath(), join(homedir(), ".pi", "agent", "extensions", "pi-multi-model-router", "config.toml"));
});

for (const scenario of [
  { name: "expands a tilde environment directory", env: "~/isolated/profile", expected: join(homedir(), "isolated/profile") },
  { name: "treats an empty environment directory as the native default", env: "", expected: join(homedir(), ".pi/agent") },
]) {
  test(`config path ${scenario.name} and preserves explicit overrides`, (t) => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    t.after(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    });
    process.env.PI_CODING_AGENT_DIR = scenario.env;
    assert.equal(getConfigPath(), join(scenario.expected, "extensions/pi-multi-model-router/config.toml"));
    assert.equal(getConfigPath("/explicit"), "/explicit/extensions/pi-multi-model-router/config.toml");
    assert.equal(getConfigPath(""), "extensions/pi-multi-model-router/config.toml");
    assert.equal(getConfigPath("~/literal"), "~/literal/extensions/pi-multi-model-router/config.toml");
  });
}

test("missing config gives zero entries and setup guidance without discovery or writes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-router-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy = join(dir, "extensions", "pi-virtual-model");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "config.toml"), sourceFor());
  const before = await readdir(dir, { recursive: true });
  const loaded = await loadConfig(dir);
  assert.equal(loaded.status, "missing");
  assert.deepEqual(loaded.config.virtualModels, []);
  assert.equal(loaded.path, getConfigPath(dir));
  assert.ok(loaded.status === "missing");
  assert.ok(loaded.diagnostic.includes(loaded.path));
  assert.match(loaded.diagnostic, /examples\/config.toml/);
  assert.match(loaded.diagnostic, /\[\[virtual_models\]\]/);
  assert.match(loaded.diagnostic, /No virtual models/);
  assert.deepEqual(await readdir(dir, { recursive: true }), before);
});

test("loader reads only the canonical configured file without modifying it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-router-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = getConfigPath(dir);
  const source = sourceFor();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  const loaded = await loadConfig(dir);
  assert.equal(loaded.status, "loaded");
  assert.equal(loaded.path, path);
  assert.deepEqual(loaded.config, parseConfig(source, path));
  assert.equal(await readFile(path, "utf8"), source);
});

test("loader honors PI_CODING_AGENT_DIR without an explicit override", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-router-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = dir;
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, sourceFor());
  const loaded = await loadConfig();
  assert.equal(loaded.status, "loaded");
  assert.equal(loaded.path, path);
});

test("loader propagates invalid configured files rather than treating them as missing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-router-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = getConfigPath(dir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "[");
  await assert.rejects(loadConfig(dir), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.configPath, path);
    assert.match(error.message, /Invalid TOML/);
    return true;
  });
});

test("loader reports non-ENOENT read errors instead of returning missing config", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-router-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(getConfigPath(dir), { recursive: true });
  await assert.rejects(loadConfig(dir), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.configPath, getConfigPath(dir));
    assert.match(error.message, /Cannot read configuration.*EISDIR/);
    return true;
  });
});
