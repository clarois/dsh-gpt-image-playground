# dsh-gpt-image-playground

A **DeepSeek Harness** plugin that adds a **GPT Image** playground to the left sidebar of the Harness Web UI, powered by [kie.ai](https://kie.ai). The sidebar entry is titled **GPT Image**.

Two tabs, one panel. Both tabs offer a **Model** dropdown covering all six GPT Image 2.6 variants:

| Tab | kie.ai model | What it does |
|---|---|---|
| **Text to image** | `gpt-image-2-6/flare-text-to-image` | Generate an image from a prompt — full control set |
| | `gpt-image-2-6/sunburst-text-to-image` | Same, rendered in the Sunburst style |
| | `gpt-image-2-6/economy-text-to-image` | Cheapest tier — 1K only, PNG only, no Quality |
| **Image to image** | `gpt-image-2-6/flare-image-to-image` | Edit up to 16 reference images with a prompt |
| | `gpt-image-2-6/sunburst-image-to-image` | Same, rendered in the Sunburst style |
| | `gpt-image-2-6/economy-image-to-image` | Cheapest edit tier — 1K only, PNG only, no Quality |

Controls adapt to the selected model, because the three tiers do not accept the same parameters:

| | Flare | Sunburst | Economy |
|---|---|---|---|
| Resolutions | 1K, 2K, 4K | 1K, 2K, 4K | 1K |
| Aspect ratios | 16 (incl. `auto`) | 16 (incl. `auto`) | 8 (incl. `auto`) |
| Formats | PNG, JPEG, WebP | PNG, JPEG, WebP | PNG |
| Quality | low → max, auto | low → max, auto | — |
| Background | auto, transparent, opaque | auto, transparent, opaque | auto, transparent, opaque |
| Prompt length | 1–32 000 | 1–32 000 | 1–20 000 |

`transparent` requires PNG or WebP, which the Host enforces.

Also implemented:

- **Remaining credits** — `GET /api/v1/chat/credit`, refreshed after each job.
- **Download links** — `POST /api/v1/common/download-url`, proxied through the Host so the 20-minute link never reaches the page.
- **File upload** — the File Upload API, so local images can become the public URLs the image-to-image models require.

## Why the architecture looks like this

kie.ai has three properties that shape the design, and all three are handled here rather than papered over:

1. **Generation is asynchronous.** `createTask` returns a `taskId`; the result arrives later. The Host owns the job and polls `recordInfo` with backoff, so a generation survives switching sidebar panels, reloading the page, or closing the tab.
2. **The API answers HTTP 200 even when the request failed.** The real status is the `code` field in the body. Every call checks it and raises that code and message, so a `402 Insufficient Credits` is never mistaken for success.
3. **The browser cannot call kie.ai directly.** All traffic goes through a same-origin Host route, which also keeps the API key out of the page.

## Requirements

- DeepSeek Harness with the Web UI.
- A kie.ai API key from <https://kie.ai/api-key>.

## Install

Clone this repository somewhere permanent, then install the folder as a bundle:

```bash
git clone https://github.com/clarois/dsh-gpt-image-playground.git
```

Then, in a DSH session, install the bundle from that directory path, for example:

```
plugin_manager install_bundle target="C:\path\to\dsh-gpt-image-playground"
```

Restart DSH afterwards. A freshly installed bundle that mounts new Host code reports `restart-required`, and the Host route is not reachable until the process restarts.

## Configure the API key

Either set the environment variable:

```bash
KIE_API_KEY=your_key_here
```

…or leave it unset and paste the key into the panel once. The key is stored through the Harness credential service on the Host and is never sent to the browser.

### Optional config

Override any of these in the profile's `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `KIE_API_KEY` | Environment variable holding the key |
| `apiBase` | `https://api.kie.ai` | Task API origin |
| `uploadBase` | `https://kieai.redpandaai.co` | File upload origin |
| `saveDirectory` | `""` | Also copy finished images into this folder |
| `pollStartMs` | `2500` | First polling interval; backs off toward ~3× |

## How it behaves

- **Results are durable.** Every image is downloaded and stored as a Harness attachment, and the panel renders it from there. History is written to `history.json` under the DSH home, so results outlive the 14-day temp URLs and a page reload. The panel shows it as a **gallery**: one card per generation carrying the prompt, settings and credits, with a lightbox (next/prev for multi-image entries).
- **Panel state survives unmounting.** The sidebar unmounts the panel whenever you select another entry; the draft prompt, options, and results are kept in plugin scope, not component state, so they are still there when you come back.
- **Uploads are retried, generations are not.** Uploading is free, so a transient failure is retried. Creating a task spends credits, so it is never retried automatically — the panel shows the failure with the stage that caused it (`upload`, `create`, `poll`, `generate`, `download`) instead.

## Endpoints used

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `{apiBase}/api/v1/jobs/createTask` | Create a generation task |
| `GET` | `{apiBase}/api/v1/jobs/recordInfo?taskId=` | Poll state and results |
| `GET` | `{apiBase}/api/v1/chat/credit` | Remaining credits |
| `POST` | `{apiBase}/api/v1/common/download-url` | Temporary download link (20 min) |
| `POST` | `{uploadBase}/api/file-base64-upload` | Local bytes → public URL (free, 24 h retention) |

Reference documentation: [Flare text to image](https://docs.kie.ai/market/gpt/gpt-image-2-6-flare-text-to-image.md), [Flare image to image](https://docs.kie.ai/market/gpt/gpt-image-2-6-flare-image-to-image.md), [Sunburst text to image](https://docs.kie.ai/market/gpt/gpt-image-2-6-sunburst-text-to-image.md), [Sunburst image to image](https://docs.kie.ai/market/gpt/gpt-image-2-6-sunburst-image-to-image.md), [Economy text to image](https://docs.kie.ai/market/gpt/gpt-image-2-6-economy-text-to-image.md), [Economy image to image](https://docs.kie.ai/market/gpt/gpt-image-2-6-economy-image-to-image.md), [credits](https://docs.kie.ai/common-api/get-account-credits.md), [download URL](https://docs.kie.ai/common-api/download-url.md).

## Development

Both halves have behaviour tests that run under plain Node with stand-ins for the Harness services and a scripted kie.ai wire:

```bash
node test/host.test.cjs
node test/client.test.cjs
```

The Host tests cover request validation per model, the exact payload each model needs, the prompt/poll/failure paths, credits, download links, and durable history. The client tests cover slot registration, both tabs, state surviving an unmount/remount, and the gallery (one card per entry, lightbox navigation, use-as-input).

The sidebar label is resolved through the client's own dictionary, published with `ctx.locale.register(...)`. The shipped `locale/en.json` is only read by the plugin manager for the bundle card, so **a title change must be made in both places**; the client test fails if the two drift apart.

## Known limits

- New Host code needs a DSH restart before its route answers; the browser half alone can hot-reload.
- Uploaded references expire after 24 hours, but each is used immediately by the task it was uploaded for.
- `download-url` only accepts URLs produced by a task result — not File Upload API URLs.
- Only the core parameters are exposed. The 2.6 API also offers `complexity`, `moderation`, `output_compression`, `mask_url`/`markup`, and GIF/SVG output; those are deliberately not wired up yet.

## License

MIT — see [LICENSE](LICENSE).
