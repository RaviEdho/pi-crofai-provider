# pi-crofai

[CrofAI](https://crof.ai) (by nahcrof) provider for [pi](https://github.com/earendil-works/pi), aligned
with their OpenAI-compatible endpoints documented at https://crof.ai/docs.

## Install

```bash
# local copy (no copying — path is referenced from settings)
pi install ./pi-crofai

# or from git (this repo)
pi install git:github.com/RaviEdho/pi-crofai-provider

# or try without installing
pi -e ./pi-crofai
```

## Authentication

Two equivalent ways:

1. **Interactive** (recommended) — stores the key in `~/.pi/agent/auth.json`:

   ```
   /login crofai   # prompts for the CrofAI API key (secret input)
   ```

2. **Environment variable** — used automatically when no stored credential exists:

   ```bash
   export CROFAI_API_KEY="your-key-from-crof.ai"   # their documented env var name
   ```

Resolution order per request: **stored credential → `$CROFAI_API_KEY` → unconfigured**
(a provider without a resolvable key is hidden from `/model`). `pi logout crofai`
removes the stored key if you ever want to switch back to the env var.

## Provider

| Provider | Endpoint | API |
|----------|----------|-----|
| `crofai` | `https://crof.ai/v1/chat/completions` | `openai-completions` |

A single provider: CrofAI's primary documented endpoint, chat completions. The model
catalogue is live-priced from `GET https://crof.ai/v1/models` (public, no auth). The
list refreshes at every pi start and on `/reload`; a static snapshot (embedded in
`extensions/index.ts`) is used as fallback when the endpoint is unreachable — startup
never blocks on the network (8s fetch timeout).

Select a model with `/model` (or Ctrl+P), e.g. `crofai/glm-5.2`,
`crofai/deepseek-v4-pro`, `crofai/greg-2-super`, `crofai/kimi-k3`.

## How it maps to CrofAI's implementation

- **Auth** — `Authorization: Bearer <key>` (handled by the OpenAI SDK clients).
- **Reasoning** — CrofAI takes a top-level `reasoning_effort` with values
  `"low" | "medium" | "high" | "none"`. pi thinking levels are mapped, and the
  `/reasoning` menu shows exactly the four supported levels:

  | pi level | `reasoning_effort` |
  |----------|--------------------|
  | off | `none` (disables thinking entirely, per their docs) |
  | low | `low` |
  | medium | `medium` |
  | high | `high` |

  `minimal`, `xhigh`, and `max` are hidden (`null` in the map) because they'd just
  alias `low`/`high` — if a selection from another model clamps onto this model,
  it lands on `low` or `high` automatically.

  Only models whose `/v1/models` entry reports `reasoning_effort: true` get the map
  (`thinking: yes` in `pi --list-models`). Greg-family and `deepseek-v3.2` models don't
  advertise the param, so pi never sends it to them — their `reasoning_content` deltas
  still stream into pi's thinking blocks natively.
- **Streaming** — standard SSE; thinking arrives as `delta.reasoning_content`, which
  pi's `openai-completions` parses natively. `stream_options.include_usage` is enabled
  and usage/cost is tracked per token using their `/v1/models` pricing ($/M, incl.
  `cache_prompt` as cache-read; cache-write is priced at 0 since they don't report it).
- **Max tokens** — `max_completion_tokens` (documented winner over `max_tokens`).
- **System role** — `supportsDeveloperRole: false`, so the system prompt is sent as
  `system` (safest across the many open-source backends their router fans out to).
- **Tool calls / structured outputs** — standard function tools with `strict` support
  (their docs show `"strict": true`); `response_format` JSON schema works via pi.
- **Vision** — standard `image_url` content; the `input` field is set from CrofAI's
  (vision) tag list on the pricing page (`images: yes` in `pi --list-models`).

## Troubleshooting

- **Provider missing from `/model`** — pi hides providers with no resolvable key; run
  `/login crofai` or make sure `CROFAI_API_KEY` is exported in the environment pi runs in.
- **`reasoning_effort` rejected on a new model** — newer models are auto-discovered;
  if `/v1/models` starts returning the flag for a model, it's picked up automatically.
- **Stale model list** — the embedded snapshot is a point-in-time copy; run `/reload`
  with network access to re-fetch, or bump the snapshot from
  `curl https://crof.ai/v1/models`.

## Development

```bash
npm install        # no runtime deps; peer types come from pi itself
pi -e ./pi-crofai  # smoke-test the package
```

Files:

```
pi-crofai/
├── package.json        # pi manifest (pi.extensions -> ./extensions)
├── README.md
└── extensions/
    └── index.ts        # provider registration (single file, no deps)
```