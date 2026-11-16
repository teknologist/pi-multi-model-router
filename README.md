# Pi multi-model router

A [Pi](https://github.com/earendil-works/pi) extension that adds virtual models. When you select one, the router asks the Jev classifier (`typesafe/jev-latest`) to pick a physical model and thinking level for each new user turn. Tool continuations and retries keep their physical target. The extension never changes your selected model.

It also includes a **status line widget**. While a virtual model is selected, it shows each physical model's share of output tokens and its speed, for example `⇄ qwen3.8-27b: 58% · 71.5 t/s | GLM-5.3-Flash-EXL3: 42% · 38.2 t/s`. See [Model token share and speed](#model-token-share-and-speed).

## Requirements

- Pi **1.5.0 or later** (`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` peer dependencies `>=1.5.0`).
- Node.js **22.19.0 or later**.
- TypeSafe credentials registered in Pi for `typesafe/jev-latest` (via `/login` or `TYPESAFE_API_KEY`).

The only runtime dependency is `smol-toml`.

## Installation

1. Clone this repository and run `npm ci`.
2. Copy `examples/config.toml` to `$PI_CODING_AGENT_DIR/extensions/pi-multi-model-router/config.toml`. If `PI_CODING_AGENT_DIR` is unset or empty, use `~/.pi/agent/extensions/pi-multi-model-router/config.toml`. Pi expands a leading `~` in that variable.
3. Edit the config so every route names a provider and model registered in your Pi catalog, with credentials configured in Pi. Do not put credentials in the TOML file.
4. Load the extension for one session with `pi -e ./index.ts`, or add the checkout's absolute path to Pi's extension configuration for persistent use.
5. Use `/model` to select a virtual model, such as `openai-codex/auto` or `router/local-ai`. After editing the config, run `/reload`.

Keep **one owner for each virtual provider/ID pair**. Do not load this extension twice through different paths or profiles, and disable any other extension that registers the same virtual IDs. No startup hook forces a selection. Each virtual ID has independent branch state.

## Configuration

The file below is the complete example in `examples/config.toml`.

```toml
[[virtual_models]]
provider = "openai-codex"
id = "auto"
name = "Auto"

[virtual_models.routing]
fallback = "balanced"

[virtual_models.routing.quick]
provider = "openai-codex"
model = "gpt-6.1-terra"
thinking_level = "low"
description = "Simple questions and small, clear tasks."

[virtual_models.routing.balanced]
model = "gpt-6.1-sol"
thinking_level = "medium"
description = "General tasks that need moderate reasoning."

[virtual_models.routing.deep]
model = "gpt-6-astra"
thinking_level = "medium"
description = "Complex tasks that need careful reasoning."

[[virtual_models]]
provider = "router"
id = "local-ai"
name = "local-ai"

[virtual_models.routing]
fallback = "balanced"

[virtual_models.routing.quick]
provider = "local-engine"
model = "qwen3.8-27b"
thinking_level = "off"
description = "Simple questions and small, clear tasks."

[virtual_models.routing.balanced]
provider = "local-engine"
model = "qwen3.8-27b"
thinking_level = "medium"
description = "General tasks that need moderate reasoning."

[virtual_models.routing.deep]
provider = "local-engine-2"
model = "GLM-5.3-Flash-EXL3"
thinking_level = "high"
description = "Complex tasks that need careful reasoning."
```

- `virtual_models` is a nonempty array. Each entry requires nonempty `provider`, `id`, and `name` strings, plus a `routing` table.
- Each `routing` table requires `fallback` and at least one named route table. `fallback` must name a route in that entry. Route names need not be `quick`, `balanced`, or `deep`.
- Each route requires `model`, `thinking_level`, and `description`. An omitted route `provider` inherits the virtual entry's provider.
- Valid levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Pi clamps a chosen level to the physical model's supported levels. `off` remains distinct from an omitted level.
- Jev receives the route names and descriptions as typed choices. There is no confidence cutoff, keyword rule, or local complexity classifier.
- Unknown fields, empty values, duplicate identities, invalid fallback names, and targets that name configured virtual models are errors. `[virtual_model]` and top-level `[routing]` are unsupported legacy schemas. There is no migration or alternate-path lookup.

The extension validates the whole config before it registers entries. A missing file gives a diagnostic and registers nothing. Invalid config gives an error and registers nothing. Registration itself is not transactional: a native physical-ID collision can reject one entry while another valid entry registers. Do not use a physical model's ID for a virtual model.

`openai-codex/auto` uses Pi's OpenAI Codex authentication availability. `router/local-ai` can appear without physical-provider credentials; Pi checks each target when routing. Provider names such as `local-engine` and `local-engine-2` are placeholders: replace them with providers registered in your Pi catalog. The extension does not create these providers.

## Routing, errors, and state

| Request | Behavior |
| --- | --- |
| New user turn | Classify the current user text with native `typesafe/jev-latest`. Use the selected route's physical pair. |
| Tool or other continuation | Use `previous` with its actual thinking level. Do not classify again. |
| Retry | Prefer `failed`, then `previous`, with the actual thinking level. Do not classify again. |
| Direct request, such as compaction | Use the configured fallback. Do not classify or change route state. |

Empty user text, missing Jev, classifier errors, malformed answers, and unavailable classified targets use the configured fallback once. An unavailable fallback ends the request with a diagnostic. An unavailable sticky target also ends the request; it must not silently switch to fallback or an older success. Cancellation propagates instead of using fallback. The extension adds no classification retry loop. Pi's native HTTP helper can make two transport retries.

Pi omits `previous` or `failed` when its physical model disappears from the catalog. The extension records the last dispatched physical identity as `{ provider, modelId }` in public route state. On retry, that state detects a missing failed identity before Pi's older `previous` can cause a silent switch. It also detects a missing identity on continuation when Pi supplies no `previous` and the visible messages lack the response. Raw successful assistant messages detect a missing previous identity when state is absent. State does not select a different available target. Available native `failed ?? previous` fields remain authoritative.

Pi stores this identity before dispatch, even if dispatch fails. The extension returns the same state object when the identity does not change. Pi stores state on the active session branch; it survives compaction and cold restart. Branch navigation and reload read that branch's stored state, not module-global state. Direct requests return no state. Shutdown removes the extension's submitted virtual identities. Reload removes old registrations and loads the current config; a missing or malformed replacement config leaves no old router registrations.

**Public-API limit:** a legacy retry without authored state cannot identify a removed failed model. Pi removes the failed response from retry messages and also omits its `failed` field when lookup fails. The router cannot distinguish that case from a routing failure with an older successful response. It therefore retains the explicit `previous` rule. If neither identity nor useful evidence exists, it uses fallback. The offline suite records this limit; the extension does not invent a hard-error policy for state conflicts.

Pi retains the virtual selection in session history and records the physical pair on assistant messages. When this extension is absent, native restore can select the last physical model instead. This is Pi behavior, not a router startup override.

## Model token share and speed

The extension publishes the status key `multi-model-router` through `ctx.ui.setStatus`. It shows output-token shares per physical model for the active virtual entry, prefixed with a dimmed `⇄`. A model used by multiple routes appears once. The most recently used model ID is bold. Percentages sum to 100. A segment looks like `qwen3.8-27b: 42% · 71.5 t/s`, and segments are joined with ` | `.

Speed is cumulative output tokens divided by cumulative wall-clock seconds from `message_start` to `message_end`. It includes provider latency and excludes Jev classification. Without timing, only the share is shown. Error and aborted messages are excluded. Direct requests such as compaction count while a virtual entry is selected. A message counts under the entry selected when it started. Counters live in memory and reset on a new session or reload. The status is hidden until the first counted message and whenever a non-router model is selected.

## Authentication and privacy

The extension uses Pi's registered catalog and `modelRegistry.classify()`. It does not read credential files, override an API key, create a transport, or log classifier payloads. Configure credentials through Pi, not through this extension. Pi can obtain registered credentials from its native credential mechanisms and environment.

Jev is an external TypeSafe service, even when every physical target is local. Each classification sends:

- The first **16,000 Unicode code points** of the latest user message's text as `state.current`.
- The last **4,000 Unicode code points** of preceding user/assistant text, including role labels, as `state.recent`.
- Fixed classification instructions and the configured route names/descriptions.

The extraction excludes system messages, tool results, tool-call arguments, thinking blocks, and images. Text typed by you or returned as assistant text can still contain secrets. **There is no secret-redaction guarantee.** Do not use this router for text that must remain on your machine.

For Pi's default text classifier, the JSON body contains `model`, `state`, and `questions`. It contains no complete transcript or images. Native HTTP headers include bearer authentication, content type, and a User-Agent that identifies Pi/version, platform, runtime, and architecture. Pi also applies configured provider/model/auth headers. These headers and normal network metadata are outside the text bounds. The bounds are not a claim that the entire HTTP request contains only these text fields.

## Development

```sh
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

`npm test` runs offline with mocked transport and dummy credentials. It covers real Pi sessions, retry and tool dispatch, removed targets, authentication loss, cancellation, cold-process restore, branch and reload state, exact classifier payloads, and loading the packed entrypoint. It makes no paid classifier or model calls. The dev dependencies pin Pi 1.5.0, the minimum supported version.

The published package contains only `index.ts`, `src/`, `examples/config.toml`, `README.md`, `LICENSE`, and `package.json`. Tests and evaluation scripts do not ship.

### Optional live classifier evaluation

`npm run evaluate:live` measures Jev routing against the synthetic fixtures in `scripts/fixtures/jev-fixtures.json`. It is not part of `npm test`. It uses your Pi-registered TypeSafe credentials and makes **52 paid classifier calls**, plus possible transport retries. It makes no physical-model calls.

```sh
npm run evaluate:live -- --allow-paid-typesafe /absolute/path/to/new-results.json
```

Without both arguments, the command stops before it loads credentials. The output path must not already exist. The report gives exact-label and acceptable-route counts, per-route counts, confusion matrices, repeat disagreements, API errors, and deep-to-quick errors. The gate requires at least 22/24 acceptable choices for the core and holdout sets, 4/4 context choices, zero API errors, and zero deep-to-quick choices. A failed gate exits nonzero. Credentials and transport error text are never saved.

## License

MIT. See `LICENSE`.
