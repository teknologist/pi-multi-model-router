# Pi multi-model router

Select a native virtual model in Pi. Jev selects a physical model and thinking level for each new user turn. Tool continuations and retries keep their physical target. The extension does not change your selected model.

This package targets **Pi 1.5.1 exactly**. It requires Node.js **22.19.0 or later**. Offline checks currently run on Node.js **25.9.0**, not the minimum version. The package is private and is not published.

## Manual installation, when authorized

These are future manual actions. This task does not install the extension into Pi.

1. Use a Pi 1.5.1 installation. In this checkout, run `npm ci` to install the pinned dependencies.
2. Check your enabled extensions. Keep **one owner for each virtual provider/ID pair**. Disable any other extension that registers `openai-codex/auto` or `router/local-ai`. Do not load this extension twice through different paths or profiles.
3. Copy `examples/config.toml` to `$PI_CODING_AGENT_DIR/extensions/pi-multi-model-router/config.toml`. If `PI_CODING_AGENT_DIR` is unset or empty, the path is `~/.pi/agent/extensions/pi-multi-model-router/config.toml`. Pi expands a leading `~` in that environment variable. An extension path does not change the config path.
4. Register the required physical providers and their credentials in Pi. Register TypeSafe credentials in Pi for `typesafe/jev-latest`. Do not put credentials in this TOML file.
5. From this checkout, start Pi with `pi -e ./index.ts`. This loads the extension for that invocation. Do not also enable it through another extension path. For persistent installation, use Pi's extension configuration with one absolute checkout path and the same one-owner rule.
6. Use `/model` to select `openai-codex/auto` or `router/local-ai`. After a config edit, use `/reload`.

The runtime dependency is `smol-toml` 1.9.1. Both Pi peer dependencies are pinned to 1.5.1. No startup hook forces a selection. Each virtual ID has independent branch state.

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

`openai-codex/auto` uses Pi's OpenAI Codex authentication availability. `router/local-ai` can appear without physical-provider credentials; Pi checks each target when routing. Provider names such as `local-engine` and `local-engine-2` must match your Pi catalog. The extension does not create these providers.

## Routing, errors, and state

| Request | Behavior |
| --- | --- |
| New user turn | Classify the current user text with native `typesafe/jev-latest`. Use the selected route's physical pair. |
| Tool or other continuation | Use `previous` with its actual thinking level. Do not classify again. |
| Retry | Prefer `failed`, then `previous`, with the actual thinking level. Do not classify again. |
| Direct request, such as compaction | Use the configured fallback. Do not classify or change route state. |

Empty user text, missing Jev, classifier errors, malformed answers, and unavailable classified targets use the configured fallback once. An unavailable fallback ends the request with a diagnostic. An unavailable sticky target also ends the request; it must not silently switch to fallback or an older success. Cancellation propagates instead of using fallback. The extension adds no classification retry loop. Pi's native HTTP helper can make two transport retries.

Pi 1.5.1 omits `previous` or `failed` when its physical model disappears from the catalog. The extension records the last dispatched physical identity as `{ provider, modelId }` in public route state. On retry, that state detects a missing failed identity before Pi's older `previous` can cause a silent switch. It also detects a missing identity on continuation when Pi supplies no `previous` and the visible messages lack the response. Raw successful assistant messages detect a missing previous identity when state is absent. State does not select a different available target. Available native `failed ?? previous` fields remain authoritative.

Pi stores this identity before dispatch, even if dispatch fails. The extension returns the same state object when the identity does not change. Pi stores state on the active session branch; it survives compaction and cold restart. Branch navigation and reload read that branch's stored state, not module-global state. Direct requests return no state. Shutdown removes the extension's submitted virtual identities. Reload removes old registrations and loads the current config; a missing or malformed replacement config leaves no old router registrations.

**Public-API limit:** a legacy retry without authored state cannot identify a removed failed model. Pi removes the failed response from retry messages and also omits its `failed` field when lookup fails. The router cannot distinguish that case from a routing failure with an older successful response. It therefore retains the explicit `previous` rule. If neither identity nor useful evidence exists, it uses fallback. The offline suite records this limit; the extension does not invent a hard-error policy for state conflicts.

Pi retains the virtual selection in session history and records the physical pair on assistant messages. When this extension is absent, native restore can select the last physical model instead. This is Pi behavior, not a router startup override.

## Authentication and privacy

The extension uses Pi's registered catalog and `modelRegistry.classify()`. It does not read credential files, override an API key, create a transport, or log classifier payloads. Configure credentials through Pi, not through this extension. Pi can obtain registered credentials from its native credential mechanisms and environment.

Jev is an external TypeSafe service, even when every physical target is local. Each classification sends:

- The first **16,000 Unicode code points** of the latest user message's text as `state.current`.
- The last **4,000 Unicode code points** of preceding user/assistant text, including role labels, as `state.recent`.
- Fixed classification instructions and the configured route names/descriptions.

The extraction excludes system messages, tool results, tool-call arguments, thinking blocks, and images. Text typed by you or returned as assistant text can still contain secrets. **There is no secret-redaction guarantee.** Do not use this router for text that must remain on your machine.

For the default Pi 1.5.1 text classifier, the JSON body contains `model`, `state`, and `questions`. It contains no complete transcript or images. Native HTTP headers include bearer authentication, content type, and a User-Agent that identifies Pi/version, platform, runtime, and architecture. Pi also applies configured provider/model/auth headers. These headers and normal network metadata are outside the text bounds. The bounds are not a claim that the entire HTTP request contains only these text fields.

## Verification

From this checkout:

```sh
npm ci
npm run typecheck
npm test
npm pack --dry-run --json
```

`npm test` is offline with mocked transport and dummy credentials. It includes real Pi sessions, retry/tool dispatch, removed targets, authentication loss, cancellation, cold-process restore, branch/reload state, exact classifier payloads, and loading the packed entrypoint. It makes no paid classifier or physical-model call. Offline checks do not prove real picker behavior, TypeSafe billing/authentication, or local balanced/deep reasoning.

The package allowlist contains only `index.ts`, `src/config.ts`, `src/router.ts`, `examples/config.toml`, `README.md`, `LICENSE`, and npm's required `package.json`. Tests, evaluation scripts, `.pi/`, and historical evidence do not ship.

## Opt-in live evaluation

This checkout includes a separate command. It is **not** part of `npm test` or ordinary CI. Obtain explicit permission before running it. It uses native registered TypeSafe credentials and synthetic fixtures only. It makes **52 classifier calls**, plus possible native transport retries, and no physical-model calls.

```sh
npm run evaluate:live -- --allow-paid-typesafe /absolute/path/to/new-results.json
```

Without both arguments, the command stops before it loads credentials. The output path must not exist. The command writes the frozen inputs and thresholds before it calls Jev. It reports exact-label and acceptable-route counts separately, per-route counts, confusion matrices, repeat disagreements, API errors, and deep-to-quick errors. A failed gate gives a nonzero exit code. A setup failure or interruption leaves a pending file, not a passing report. Transport error text and credentials are not saved.

The fixed gate requires at least **22/24** acceptable choices for each of the original and holdout sets, **4/4** context choices, zero API errors, and zero deep-to-quick choices. The historical holdout is already consumed; a rerun is not an unseen evaluation. A new tuning claim needs separately frozen, unseen fixtures and separate authorization.

Historical evidence remains under `docs/plans/evidence/2026-11-12-jev/`. The original strict baseline is **21/24, FAIL**. The separately authorized revised run has original exact **21/24**, original acceptable **24/24**, holdout **24/24**, and context **4/4**, with zero API errors or deep-to-quick choices. This task does not rerun it. These small synthetic results do not prove physical answer quality or general routing reliability.

## License and status

MIT. This is an independent implementation. It does not include the excluded, unlicensed upstream router source.

Implementation Gates 0–4 pass. Final validation is **offline (mocked transport)**: 456 tests pass with no failures or skipped tests. Independent core, native integration, dispatch-evidence, and evaluation reviews pass. Clean install, strict typecheck, packed loading, and the seven-file package allowlist pass. See `docs/plans/2026-11-12-multi-model-router-handoff.md` for exact evidence and remaining live checks.

No Pi installation, commit, push, or publication occurs. Minimum-Node execution, Windows behavior, and power-loss durability remain unverified. Abrupt termination can leave an evaluation temporary file; incomplete final-report writes do not replace the pending report.
