/**
 * Host half of the GPT Image bundle.
 *
 * Everything that touches kie.ai runs here, for three reasons:
 *   - the API key never reaches the browser page;
 *   - kie.ai sends no CORS headers, so the page cannot call it directly;
 *   - generation is asynchronous, and a job must survive the user switching
 *     sidebar panels, reloading the page, or closing the browser tab.
 *
 * The browser half reaches this module same-origin through the route below.
 *
 * Config (override in the profile's `cordis.patch.yml`):
 *   apiKeyEnv    environment variable holding the key (default KIE_API_KEY)
 *   apiBase      task API origin (default https://api.kie.ai)
 *   uploadBase   file upload origin (default https://kieai.redpandaai.co)
 *   saveDirectory optional directory to also copy finished images into
 *
 * kie.ai contracts implemented here, all from docs.kie.ai:
 *   POST {apiBase}/api/v1/jobs/createTask          create a generation task
 *   GET  {apiBase}/api/v1/jobs/recordInfo?taskId=  poll task state and results
 *   GET  {apiBase}/api/v1/chat/credit              remaining credits
 *   POST {apiBase}/api/v1/common/download-url      temporary download link
 *   POST {uploadBase}/api/file-base64-upload       turn local bytes into a URL
 */

const DEFAULT_API_BASE = 'https://api.kie.ai'
const DEFAULT_UPLOAD_BASE = 'https://kieai.redpandaai.co'
const DEFAULT_ENV_NAME = 'KIE_API_KEY'
const ROUTE_PATH = '/gpt-image-playground/api'

const HISTORY_LIMIT = 100
const POLL_START_MS = 2500
const POLL_MAX_MS = 8000
const POLL_TIMEOUT_MS = 12 * 60 * 1000
const MAX_IMAGE_BYTES = 30 * 1024 * 1024

export const inject = ['webServer']

/* --------------------------------------------------------------- configuration */

/**
 * Resolve `@deepseek-ai/schemastery` from the running Harness.
 *
 * A bundle is linked into the profile, so Node's resolution from this directory
 * cannot see the dsh installation; a dynamic import resolves it at runtime.
 */
async function loadSchemastery() {
  try {
    const module = await import('@deepseek-ai/schemastery')
    return module.default ?? module
  } catch {
    return undefined
  }
}

const z = await loadSchemastery()

/**
 * Cordis validates a row's `config` through `Config['~standard'].validate` and
 * skips validation when `Config` is falsy â€” so a plain object literal here would
 * crash activation. Export a real schema, or nothing at all.
 */
const configSchema =
  typeof z?.object === 'function'
    ? z.object({
        apiKeyEnv: z.string().default(DEFAULT_ENV_NAME),
        apiBase: z.string().default(DEFAULT_API_BASE),
        uploadBase: z.string().default(DEFAULT_UPLOAD_BASE),
        saveDirectory: z.string().default(''),
        pollStartMs: z.number().default(POLL_START_MS),
      })
    : undefined

export const Config = configSchema?.['~standard'] ? configSchema : undefined

/* --------------------------------------------------------------------- models */

/**
 * GPT Image 2.6 parameter vocabulary, taken from the per-model kie.ai docs.
 *
 * All six 2.6 generations share one envelope: `gpt-image-2-6/<tier>-<op>`. The
 * tiers differ in what they accept, which is why each model carries its own
 * lists rather than sharing one global set.
 */

/** Flare and Sunburst both accept the full 16-value ratio set, including `auto`. */
const FLARE_RATIOS = [
  'auto',
  '1:1',
  '3:2',
  '2:3',
  '4:3',
  '3:4',
  '5:4',
  '4:5',
  '16:9',
  '9:16',
  '2:1',
  '1:2',
  '21:9',
  '9:21',
  '3:1',
  '1:3',
]
const FLARE_SIZES = ['1K', '2K', '4K']
/** Static-image formats only: gif and svg are deliberately out of scope here. */
const FLARE_FORMATS = ['png', 'jpeg', 'webp']
const FLARE_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
const FLARE_BACKGROUNDS = ['auto', 'transparent', 'opaque']

/** Economy is the cheap tier: 1K only, no quality dial, a narrower ratio set. */
const ECONOMY_RATIOS = ['auto', '1:1', '16:9', '9:16', '3:2', '2:3', '21:9', '4:3']
const ECONOMY_SIZES = ['1K']
/** Economy text-to-image also writes gif; both variants here stay on png. */
const ECONOMY_FORMATS = ['png']
const ECONOMY_BACKGROUNDS = ['auto', 'transparent', 'opaque']

/** Flare and Sunburst allow 32000 characters; Economy stops at 20000. */
const LARGE_PROMPT_LIMITS = { min: 1, max: 32000 }
const ECONOMY_PROMPT_LIMITS = { min: 1, max: 20000 }

/**
 * The playground catalog: one entry per switchable model, tagged with the mode
 * whose tab shows it.
 *
 * `key` is the stable identifier the panel and history use; `id` is what kie.ai
 * receives. Both tabs offer all three tiers, so `modelFor` resolves by mode
 * *and* key, never by mode alone.
 *
 * `maxRefs` follows the docs: text to image takes none, image to image takes up
 * to 16 uploaded URLs. Economy's image-to-image documents `input_urls` as
 * optional, but offering it with zero source images duplicates the
 * text-to-image tab, so it requires one here.
 */
const MODELS = [
  {
    key: 'flare-text-to-image',
    id: 'gpt-image-2-6/flare-text-to-image',
    mode: 'text2image',
    label: 'GPT Image 2.6 Flare',
    version: '2.6 Flare',
    minRefs: 0,
    maxRefs: 0,
    sizes: FLARE_SIZES,
    aspectRatios: FLARE_RATIOS,
    formats: FLARE_FORMATS,
    backgrounds: FLARE_BACKGROUNDS,
    qualities: FLARE_QUALITIES,
    promptRequired: true,
    promptLimits: LARGE_PROMPT_LIMITS,
  },
  {
    key: 'sunburst-text-to-image',
    id: 'gpt-image-2-6/sunburst-text-to-image',
    mode: 'text2image',
    label: 'GPT Image 2.6 Sunburst',
    version: '2.6 Sunburst',
    minRefs: 0,
    maxRefs: 0,
    sizes: FLARE_SIZES,
    aspectRatios: FLARE_RATIOS,
    formats: FLARE_FORMATS,
    backgrounds: FLARE_BACKGROUNDS,
    qualities: FLARE_QUALITIES,
    promptRequired: true,
    promptLimits: LARGE_PROMPT_LIMITS,
  },
  {
    key: 'economy-text-to-image',
    id: 'gpt-image-2-6/economy-text-to-image',
    mode: 'text2image',
    label: 'GPT Image 2.6 Economy',
    version: '2.6 Economy',
    minRefs: 0,
    maxRefs: 0,
    sizes: ECONOMY_SIZES,
    aspectRatios: ECONOMY_RATIOS,
    formats: ECONOMY_FORMATS,
    backgrounds: ECONOMY_BACKGROUNDS,
    qualities: [],
    promptRequired: true,
    promptLimits: ECONOMY_PROMPT_LIMITS,
  },
  {
    key: 'flare-image-to-image',
    id: 'gpt-image-2-6/flare-image-to-image',
    mode: 'image2image',
    label: 'GPT Image 2.6 Flare',
    version: '2.6 Flare',
    minRefs: 1,
    maxRefs: 16,
    sizes: FLARE_SIZES,
    aspectRatios: FLARE_RATIOS,
    formats: FLARE_FORMATS,
    backgrounds: FLARE_BACKGROUNDS,
    qualities: FLARE_QUALITIES,
    promptRequired: true,
    promptLimits: LARGE_PROMPT_LIMITS,
  },
  {
    key: 'sunburst-image-to-image',
    id: 'gpt-image-2-6/sunburst-image-to-image',
    mode: 'image2image',
    label: 'GPT Image 2.6 Sunburst',
    version: '2.6 Sunburst',
    minRefs: 1,
    maxRefs: 16,
    sizes: FLARE_SIZES,
    aspectRatios: FLARE_RATIOS,
    formats: FLARE_FORMATS,
    backgrounds: FLARE_BACKGROUNDS,
    qualities: FLARE_QUALITIES,
    promptRequired: true,
    promptLimits: LARGE_PROMPT_LIMITS,
  },
  {
    key: 'economy-image-to-image',
    id: 'gpt-image-2-6/economy-image-to-image',
    mode: 'image2image',
    label: 'GPT Image 2.6 Economy',
    version: '2.6 Economy',
    minRefs: 1,
    maxRefs: 16,
    sizes: ECONOMY_SIZES,
    aspectRatios: ECONOMY_RATIOS,
    formats: ECONOMY_FORMATS,
    backgrounds: ECONOMY_BACKGROUNDS,
    qualities: [],
    promptRequired: true,
    promptLimits: ECONOMY_PROMPT_LIMITS,
  },
]

/** Prompt bounds for one model. Every 2.6 model documents its own. */
function promptLimitsFor(model) {
  return model.promptLimits ?? LARGE_PROMPT_LIMITS
}

const MODES = [...new Set(MODELS.map((model) => model.mode))]

/** Entries offered by one tab, in catalog order. */
function modelsForMode(mode) {
  return MODELS.filter((model) => model.mode === mode)
}

/**
 * Resolve the selected model. Falls back to the tab's first entry so a stored
 * draft or an older history entry that names no key still resolves.
 */
function modelFor(mode, key) {
  const candidates = modelsForMode(mode)
  if (candidates.length === 0) return undefined
  const wanted = clean(key)
  if (wanted === '') return candidates[0]
  return candidates.find((model) => model.key === wanted || model.id === wanted) ?? candidates[0]
}

/* --------------------------------------------------------------------- errors */

/**
 * A failure that names the stage it came from.
 *
 * The stage decides what may safely be retried. Uploading is free, so it is
 * retried automatically; creating a task spends credits, so it never is.
 */
class StageError extends Error {
  constructor(stage, message, { code = 0, retryable = false } = {}) {
    super(message)
    this.name = 'StageError'
    this.stage = stage
    this.code = code
    this.retryable = retryable
  }
}

/* -------------------------------------------------------------------- helpers */

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function toNumber(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? n : 0
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** kie.ai answers HTTP 200 even on failure, so `code` is the real status. */
function assertOk(payload, stage) {
  const code = payload?.code
  if (typeof code === 'number' && code !== 200) {
    throw new StageError(stage, `kie.ai ${code}: ${clean(payload?.msg) || 'the request failed'}`, {
      code,
      // 429 and 455 are transient; a 402 is a billing problem the user must fix.
      retryable: code === 429 || code === 455 || code === 500,
    })
  }
  if (payload?.success === false) {
    throw new StageError(stage, `kie.ai: ${clean(payload?.msg) || 'the request failed'}`, {
      code: typeof code === 'number' ? code : 0,
      retryable: code === 429 || code === 455 || code === 500,
    })
  }
  return payload
}

/** One authenticated JSON call, with kie.ai's error contract unwrapped. */
async function callApi(url, { apiKey, method = 'GET', body, signal, stage }) {
  let response
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    })
  } catch (error) {
    throw new StageError(stage, `Could not reach kie.ai: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: true,
    })
  }

  const text = await response.text().catch(() => '')
  if (!response.ok && text.trim() === '') {
    throw new StageError(stage, `kie.ai returned HTTP ${response.status}.`, {
      retryable: response.status >= 500 || response.status === 429,
    })
  }
  let payload
  try {
    payload = text.trim() === '' ? {} : JSON.parse(text)
  } catch {
    throw new StageError(stage, 'kie.ai returned a response that was not JSON.')
  }
  return assertOk(payload, stage)
}

/* ------------------------------------------------------------- task lifecycle */

/**
 * Create one generation task.
 *
 * Never retried automatically: a task that was accepted is billed even if its
 * result is unclear, and the docs say to check before resubmitting.
 */
async function createTask(apiKey, apiBase, model, input, signal) {
  const payload = await callApi(`${apiBase}/api/v1/jobs/createTask`, {
    apiKey,
    method: 'POST',
    body: { model, input },
    signal,
    stage: 'create',
  })
  const taskId = clean(payload?.data?.taskId)
  if (taskId === '') throw new StageError('create', 'kie.ai accepted the request but returned no taskId.')
  return taskId
}

/** Read one task's state and payload. */
async function getTask(apiKey, apiBase, taskId, signal) {
  return callApi(`${apiBase}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    apiKey,
    signal,
    stage: 'poll',
  })
}

/**
 * Wait for a task to finish, with the backoff the docs recommend.
 *
 * Polling is a read, so a transient read failure is tolerated and retried on the
 * next tick instead of failing the whole job.
 *
 * @returns {Promise<object>} the finished task's `data`
 */
async function pollTask(apiKey, apiBase, taskId, signal, onState, startMs = POLL_START_MS) {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  // Start where the docs recommend and back off toward a cap, so a short task is
  // answered quickly while a long one does not hammer the endpoint.
  let delay = Math.max(10, Math.round(startMs))
  const maxDelay = Math.max(delay, Math.round(delay * 3.2))
  let lastState = ''

  for (;;) {
    if (signal?.aborted) throw new StageError('poll', 'Cancelled.')

    let data
    try {
      const payload = await getTask(apiKey, apiBase, taskId, signal)
      data = payload?.data ?? {}
      const state = clean(data.state).toLowerCase()
      if (state !== lastState) {
        lastState = state
        onState?.(state)
      }
      if (state === 'success') return data
      if (state === 'fail') {
        throw new StageError('generate', clean(data.failMsg) || 'kie.ai reported that generation failed.', {
          code: Number.parseInt(clean(data.failCode), 10) || 0,
        })
      }
    } catch (error) {
      // A real generation failure must surface; a flaky read may be retried.
      if (error instanceof StageError && error.stage === 'generate') throw error
      if (Date.now() > deadline) {
        throw error instanceof StageError
          ? error
          : new StageError('poll', error instanceof Error ? error.message : String(error))
      }
    }

    if (Date.now() > deadline) {
      throw new StageError(
        'poll',
        `Timed out after ${Math.round(POLL_TIMEOUT_MS / 60000)} minutes waiting for kie.ai. The task may still finish; check its history later.`,
      )
    }
    await sleep(delay)
    delay = Math.min(Math.round(delay * 1.3), POLL_MAX_MS)
  }
}

/** `resultJson` is a JSON string; tolerate an already-parsed object too. */
function parseResultJson(data) {
  const raw = data?.resultJson
  if (raw !== null && typeof raw === 'object') return raw
  const text = clean(raw)
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/* -------------------------------------------------------------------- uploads */

function stripDataUrl(value) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (!match) return { data: value, mediaType: '' }
  return { data: match[2] ? match[3] : decodeURIComponent(match[3]), mediaType: clean(match[1]) }
}

/**
 * Turn local image bytes into a public URL, which is what the image-to-image
 * endpoints require (`input_urls`).
 *
 * Uploads are free per the docs, so a transient failure is retried; uploaded
 * files are deleted after 24 hours, which is fine because each generation runs
 * immediately after its own upload.
 */
async function uploadImage(apiKey, uploadBase, reference, signal) {
  const declared = clean(reference?.mediaType) || 'image/png'
  const { data } = stripDataUrl(clean(reference?.data))
  if (data === '') throw new StageError('upload', 'A reference image was empty.')

  const bytes = Buffer.from(data, 'base64')
  if (bytes.byteLength === 0) throw new StageError('upload', 'A reference image could not be decoded.')
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new StageError('upload', `Reference images must be ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB or smaller.`)
  }

  const mediaType = /^image\/(png|jpeg|webp)$/.test(declared) ? declared : 'image/png'
  const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'
  const fileName = `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`

  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (signal?.aborted) throw new StageError('upload', 'Cancelled.')
    try {
      const payload = await callApi(`${uploadBase}/api/file-base64-upload`, {
        apiKey,
        method: 'POST',
        body: {
          base64Data: `data:${mediaType};base64,${data}`,
          uploadPath: 'images/dsh-playground',
          fileName,
        },
        signal,
        stage: 'upload',
      })
      const url = clean(payload?.data?.downloadUrl)
      if (url === '') throw new StageError('upload', 'kie.ai uploaded the file but returned no downloadUrl.')
      return url
    } catch (error) {
      lastError = error
      if (!(error instanceof StageError) || !error.retryable || attempt === 3) throw error
      await sleep(700 * 2 ** (attempt - 1))
    }
  }
  throw lastError
}

/* -------------------------------------------------------------------- history */

/**
 * Durable generation history, owned by the Host.
 *
 * The panel unmounts whenever the user selects another sidebar entry, so any
 * state kept in React would be lost. History therefore lives in a JSON file and
 * points at durable attachments, which is what lets a finished picture survive a
 * page reload and a running task survive a panel switch.
 */
class History {
  constructor(file, limit) {
    this.file = file
    this.limit = limit
    this.entries = []
    this.loaded = false
    this.writes = Promise.resolve()
  }

  async load() {
    if (this.loaded) return this.entries
    this.loaded = true
    try {
      const { readFile } = await import('node:fs/promises')
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      if (Array.isArray(parsed?.entries)) this.entries = parsed.entries
    } catch {
      this.entries = []
    }
    return this.entries
  }

  async flush() {
    this.entries = this.entries.slice(0, this.limit)
    try {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, JSON.stringify({ version: 1, entries: this.entries }, null, 2))
    } catch {
      // A failed write must not discard the list the panel is already showing.
    }
  }

  /** Serialize mutations so two finishing jobs cannot interleave a write. */
  mutate(fn) {
    const next = this.writes.then(async () => {
      await this.load()
      const result = await fn(this.entries)
      await this.flush()
      return result
    })
    this.writes = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async list() {
    await this.load()
    return this.entries
  }

  start(entry) {
    return this.mutate((entries) => {
      entries.unshift({ ...entry, state: 'running', createdAt: Date.now() })
      return entry.id
    })
  }

  settle(id, patch) {
    return this.mutate((entries) => {
      const index = entries.findIndex((item) => item.id === id)
      if (index === -1) return undefined
      if (patch === null) {
        entries.splice(index, 1)
        return undefined
      }
      entries[index] = { ...entries[index], ...patch, settledAt: Date.now() }
      return entries[index]
    })
  }

  remove(id) {
    return this.mutate((entries) => {
      const index = entries.findIndex((item) => item.id === id)
      if (index !== -1) entries.splice(index, 1)
    })
  }

  clear() {
    return this.mutate((entries) => {
      entries.length = 0
    })
  }
}

let historyStore

async function history() {
  if (historyStore === undefined) {
    const { join } = await import('node:path')
    const home = clean(process.env.DSH_HOME)
    const directory = home === '' ? join(process.cwd(), '.gpt-image-playground') : join(home, 'gpt-image-playground')
    historyStore = new History(join(directory, 'history.json'), HISTORY_LIMIT)
  }
  return historyStore
}

/* ----------------------------------------------------------------------- jobs */

/** In-flight tasks, so a cancel can reach the polling loop. */
const jobs = new Map()

/** Resolve the API key and endpoints, or explain how to configure them. */
async function resolveCredentials(ctx, config) {
  const apiKeyEnv = clean(config?.apiKeyEnv) || DEFAULT_ENV_NAME
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error('The credential service is unavailable in this profile.')
  }
  const resolved = await credentials.resolve(apiKeyEnv)
  const apiKey = clean(resolved?.value)
  if (apiKey === '') {
    throw new Error(
      `kie.ai API key not configured. Set ${apiKeyEnv} in the environment, or paste a key in the panel.`,
    )
  }
  return {
    apiKey,
    apiKeyEnv,
    apiBase: (clean(config?.apiBase) || DEFAULT_API_BASE).replace(/\/+$/, ''),
    uploadBase: (clean(config?.uploadBase) || DEFAULT_UPLOAD_BASE).replace(/\/+$/, ''),
    pollStartMs: toNumber(config?.pollStartMs) > 0 ? toNumber(config?.pollStartMs) : POLL_START_MS,
  }
}

/** Validate one panel submission into the fields the API accepts. */
export function normalizeRequest(input) {
  const mode = clean(input?.mode) || 'text2image'
  const model = modelFor(mode, input?.model)
  if (model === undefined) throw new Error(`Unknown mode: ${mode}`)

  const prompt = clean(input?.prompt)
  if (model.promptRequired && prompt === '') throw new Error('A prompt is required.')
  const limits = promptLimitsFor(model)
  if (prompt !== '' && (prompt.length < limits.min || prompt.length > limits.max)) {
    throw new Error(`The prompt must be between ${limits.min} and ${limits.max} characters.`)
  }

  const references = Array.isArray(input?.references)
    ? input.references.map((value) => clean(typeof value === 'string' ? value : value?.data)).filter((v) => v !== '')
    : []

  if (references.length < model.minRefs) throw new Error('This function needs at least one source image.')
  if (references.length > model.maxRefs) {
    throw new Error(`${model.label} accepts at most ${model.maxRefs} reference image(s).`)
  }

  const aspectRatio = clean(input?.aspectRatio) || model.aspectRatios[0]
  if (!model.aspectRatios.includes(aspectRatio)) {
    throw new Error(`${aspectRatio} is not a supported aspect ratio. Choose one of ${model.aspectRatios.join(', ')}.`)
  }

  const size = clean(input?.size) || model.sizes[0]
  if (!model.sizes.includes(size)) {
    throw new Error(`${size} is not a supported resolution for ${model.label}.`)
  }

  const format = clean(input?.format) || 'png'
  if (!model.formats.includes(format)) throw new Error(`${format} is not a supported output format.`)

  // Every 2.6 model documents `background`; `transparent` is only writable to
  // PNG and webp, which the docs state and this enforces.
  let background = clean(input?.background) || model.backgrounds[0]
  if (!model.backgrounds.includes(background)) {
    throw new Error(`${background} is not a supported background for ${model.label}.`)
  }
  if (background === 'transparent' && format !== 'png' && format !== 'webp') {
    throw new Error('A transparent background requires the PNG or webp format.')
  }

  // Flare and Sunburst expose a quality dial; Economy has none and would reject
  // the parameter.
  let quality = ''
  if (Array.isArray(model.qualities) && model.qualities.length > 0) {
    quality = clean(input?.quality) || 'medium'
    if (!model.qualities.includes(quality)) {
      throw new Error(`${quality} is not a supported quality for ${model.label}.`)
    }
  }

  return {
    mode,
    modelKey: model.key,
    model: model.id,
    label: model.label,
    prompt,
    references,
    aspectRatio,
    size,
    format,
    background,
    quality,
  }
}

/** Shape the `input` object for one model, exactly as each doc requires. */
function buildTaskInput(request, imageUrls) {
  const input = {
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio,
    resolution: request.size,
    output_format: request.format,
    background: request.background,
  }
  // The docs name the reference array `input_urls` across all six 2.6 models.
  if (request.mode === 'image2image') input.input_urls = imageUrls
  if (request.quality !== '') input.quality = request.quality
  return input
}

/** Persist one result URL's bytes as a durable attachment. */
async function storeImage(ctx, url, name, signal) {
  const attachments = ctx.get('attachments')
  let bytes
  let mediaType = 'image/png'
  try {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    mediaType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() || mediaType
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    return { url, name, saved: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (bytes.byteLength === 0) return { url, name, saved: false, reason: 'kie.ai returned an empty image body.' }

  if (attachments === undefined) return { url, name, saved: false, reason: 'The attachment service is unavailable.' }

  const type = /^image\/(png|jpeg|webp)$/.test(mediaType) ? mediaType : 'image/png'
  try {
    const ref = await attachments.saveImage({ data: bytes, mediaType: type, name })
    // Persist the *whole* reference, not just its id. `readImage` re-verifies
    // mediaType/width/height/bytes against the stored file and throws
    // ATTACHMENT_CORRUPT on any mismatch, so dropping these fields here is what
    // made every thumbnail fail to load. The values must be the normalized
    // ones the store reported (it re-encodes on save), never the source
    // response's, because a downscale would change both bytes and dimensions.
    return { url, name, saved: true, ref: toStoredRef(ref), mediaType: ref?.mediaType ?? type, bytes: ref?.bytes ?? bytes.byteLength }
  } catch (error) {
    return { url, name, saved: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Keep only the reference fields the attachment service verifies, so what we
 * write to history is exactly what we can hand back to `readImage` later.
 */
function toStoredRef(ref) {
  if (ref === undefined || ref === null) return undefined
  const attachmentId = clean(ref.attachmentId)
  if (attachmentId === '') return undefined
  const stored = { attachmentId }
  const mediaType = clean(ref.mediaType)
  if (mediaType !== '') stored.mediaType = mediaType
  if (Number.isFinite(ref.width)) stored.width = Number(ref.width)
  if (Number.isFinite(ref.height)) stored.height = Number(ref.height)
  if (Number.isFinite(ref.bytes)) stored.bytes = Number(ref.bytes)
  const name = clean(ref.name)
  if (name !== '') stored.name = name
  if (ref.originalDimensions !== undefined) stored.originalDimensions = ref.originalDimensions
  return stored
}

/** Copy a finished image into the configured directory, when one is set. */
async function mirrorToDisk(directory, name, url, signal) {
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { join, resolve, sep } = await import('node:path')
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const root = resolve(directory)
    const target = resolve(join(root, name))
    if (target !== root && !target.startsWith(root + sep)) throw new Error('Path escaped the configured directory.')
    await mkdir(root, { recursive: true })
    await writeFile(target, bytes)
    return { saved: true, path: target }
  } catch (error) {
    return { saved: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Run one generation end to end.
 *
 * Order matters: upload references, create the task, poll it, then download each
 * result into a durable attachment. Nothing is retried after `createTask`
 * succeeds, because that is the point where credits are spent.
 */
async function runJob(env, jobId, request, store, controller) {
  const { ctx, config, apiKey, apiBase, uploadBase, pollStartMs } = env
  try {
    const imageUrls = []
    for (let index = 0; index < request.references.length; index += 1) {
      imageUrls.push(await uploadImage(apiKey, uploadBase, { data: request.references[index] }, controller.signal))
    }

    const input = buildTaskInput(request, imageUrls)
    const taskId = await createTask(apiKey, apiBase, request.model, input, controller.signal)
    await store.settle(jobId, { taskId, state: 'running' })

    const data = await pollTask(apiKey, apiBase, taskId, controller.signal, (state) => {
      void store.settle(jobId, { taskId, state: 'running', remoteState: state })
    }, pollStartMs)

    const parsed = parseResultJson(data)
    const urls = Array.isArray(parsed.resultUrls) ? parsed.resultUrls.map(clean).filter((url) => url !== '') : []
    if (urls.length === 0) {
      throw new StageError('generate', 'kie.ai finished the task but returned no image URL.')
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const images = []
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index]
      const name = `gpt-image-${stamp}-${index + 1}.${request.format === 'jpeg' ? 'jpg' : request.format}`
      const stored = await storeImage(ctx, url, name, controller.signal)
      const directory = clean(config?.saveDirectory)
      const disk = directory === '' ? undefined : await mirrorToDisk(directory, name, url, controller.signal)
      images.push({ ...stored, disk })
    }

    await store.settle(jobId, {
      state: 'done',
      taskId,
      remoteState: 'success',
      images,
      creditsConsumed: toNumber(data.creditsConsumed),
      costTime: toNumber(data.costTime),
    })
  } catch (error) {
    const stage = error instanceof StageError ? error.stage : 'unknown'
    const message = error instanceof Error ? error.message : String(error)
    const failCode = error instanceof StageError ? error.code : 0
    await store.settle(jobId, { state: 'error', error: message, stage, failCode })
  } finally {
    jobs.delete(jobId)
  }
}

/* --------------------------------------------------------------------- public */

/** Start a generation. Returns as soon as the job is durable, not when it ends. */
export async function startJob(ctx, config, input) {
  const request = normalizeRequest(input)
  const credentials = await resolveCredentials(ctx, config)
  const store = await history()

  const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  await store.start({
    id: jobId,
    taskId: '',
    mode: request.mode,
    modelKey: request.modelKey,
    model: request.model,
    label: request.label,
    prompt: request.prompt,
    aspectRatio: request.aspectRatio,
    size: request.size,
    format: request.format,
    background: request.background,
    quality: request.quality,
  })

  const controller = new AbortController()
  jobs.set(jobId, { controller })

  const env = { ctx, config: config ?? {}, ...credentials }
  void runJob(env, jobId, request, store, controller)

  return { jobId }
}

/** Cancel a running job. Its history entry is dropped. */
export async function cancelJob(ctx, config, input) {
  void ctx
  void config
  const jobId = clean(input?.jobId)
  const job = jobs.get(jobId)
  if (job === undefined) return { cancelled: false }
  job.controller.abort(new Error('Cancelled by the user.'))
  jobs.delete(jobId)
  const store = await history()
  await store.settle(jobId, null)
  return { cancelled: true }
}

/** Generation history, newest first. */
export async function listHistory() {
  const store = await history()
  return { entries: await store.list(), running: [...jobs.keys()] }
}

/** Forget every history entry. Stored attachments are left in place. */
export async function clearHistory() {
  const store = await history()
  await store.clear()
  return { entries: [] }
}

/** Forget one history entry. */
export async function removeHistory(input) {
  const store = await history()
  await store.remove(clean(input?.id))
  return { entries: await store.list() }
}

/** Remaining credits, straight from `GET /api/v1/chat/credit`. */
export async function credits(ctx, config) {
  const { apiKey, apiBase } = await resolveCredentials(ctx, config)
  const payload = await callApi(`${apiBase}/api/v1/chat/credit`, { apiKey, stage: 'credits' })
  const value = toNumber(payload?.data)
  return { credits: value, raw: payload?.data }
}

/**
 * Mint a temporary download link for a generated file.
 *
 * `POST /api/v1/common/download-url` only accepts URLs that came from a task
 * result â€” not File Upload API URLs â€” and the link is valid for 20 minutes.
 */
export async function downloadLink(ctx, config, input) {
  const url = clean(input?.url)
  if (url === '') throw new Error('A result URL is required.')
  const { apiKey, apiBase } = await resolveCredentials(ctx, config)
  const payload = await callApi(`${apiBase}/api/v1/common/download-url`, {
    apiKey,
    method: 'POST',
    body: { url },
    stage: 'download',
  })
  const link = clean(payload?.data)
  if (link === '') throw new StageError('download', 'kie.ai returned no download link.')
  return { url: link, expiresInMinutes: 20 }
}

/** Non-secret status for the panel. */
export async function status(ctx, config) {
  const apiKeyEnv = clean(config?.apiKeyEnv) || DEFAULT_ENV_NAME
  const credentials = ctx.get('credentials')
  let configured = false
  let source
  let writable = false
  if (credentials !== undefined) {
    try {
      const info = await credentials.describe(apiKeyEnv)
      configured = info?.configured === true
      source = info?.source
      writable = info?.writable === true
    } catch {
      configured = false
    }
  }
  return {
    configured,
    source,
    writable,
    apiKeyEnv,
    apiBase: (clean(config?.apiBase) || DEFAULT_API_BASE).replace(/\/+$/, ''),
    saveDirectory: clean(config?.saveDirectory),
    defaultMode: 'text2image',
    aspectRatios: FLARE_RATIOS,
    models: MODELS.map((model) => ({
      key: model.key,
      id: model.id,
      mode: model.mode,
      label: model.label,
      version: model.version,
      maxReferences: model.maxRefs,
      minReferences: model.minRefs,
      sizes: model.sizes,
      aspectRatios: model.aspectRatios,
      formats: model.formats,
      backgrounds: model.backgrounds,
      qualities: model.qualities ?? [],
      promptRequired: model.promptRequired,
      promptLimits: promptLimitsFor(model),
    })),
  }
}

/** Store the API key through the credential service. */
export async function setApiKey(ctx, config, input) {
  const value = clean(input?.apiKey)
  if (value === '') throw new Error('The API key was empty.')
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('The credential service is unavailable in this profile.')
  const apiKeyEnv = clean(config?.apiKeyEnv) || DEFAULT_ENV_NAME
  await credentials.set(apiKeyEnv, value)
  return { configured: true, apiKeyEnv }
}

/** Remove the stored API key. */
export async function clearApiKey(ctx, config) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('The credential service is unavailable in this profile.')
  const apiKeyEnv = clean(config?.apiKeyEnv) || DEFAULT_ENV_NAME
  await credentials.unset(apiKeyEnv)
  return { configured: false, apiKeyEnv }
}

/** Re-serve a durable attachment so results stay viewable after reloads. */
export async function readStoredImage(ctx, input) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('The attachment service is unavailable.')
  const ref = normalizeStoredRef(input?.ref)
  if (ref === undefined) throw new Error('A complete stored reference is required.')
  const stored = await attachments.readImage(ref)
  return {
    bytes: stored.data,
    mediaType: stored.ref?.mediaType ?? ref.mediaType ?? 'image/png',
    name: stored.ref?.name ?? ref.name ?? 'image.png',
  }
}

/**
 * Rebuild the reference `readImage` verifies. The service compares media type,
 * byte length, width and height against the stored object, so a reference
 * missing any of those is rejected as corrupt â€” a bare `{ attachmentId }` will
 * not read. History written by older builds stored only the id, so those
 * entries are reported as unavailable rather than surfacing a corrupt error.
 */
function normalizeStoredRef(value) {
  if (value === undefined || value === null) return undefined
  const attachmentId = clean(value.attachmentId)
  const mediaType = clean(value.mediaType)
  if (attachmentId === '' || mediaType === '') return undefined
  const width = toNumber(value.width)
  const height = toNumber(value.height)
  const bytes = toNumber(value.bytes)
  if (width <= 0 || height <= 0 || bytes <= 0) return undefined
  const ref = { attachmentId, mediaType, width, height, bytes }
  const name = clean(value.name)
  if (name !== '') ref.name = name
  return ref
}

/* ---------------------------------------------------------------------- route */

const METHODS = {
  status: (ctx, config) => status(ctx, config),
  credits: (ctx, config) => credits(ctx, config),
  startJob: (ctx, config, args) => startJob(ctx, config, args),
  cancelJob: (ctx, config, args) => cancelJob(ctx, config, args),
  listHistory: () => listHistory(),
  clearHistory: () => clearHistory(),
  removeHistory: (ctx, config, args) => removeHistory(args),
  downloadLink: (ctx, config, args) => downloadLink(ctx, config, args),
  setApiKey: (ctx, config, args) => setApiKey(ctx, config, args),
  clearApiKey: (ctx, config) => clearApiKey(ctx, config),
}

/**
 * Route the browser half's calls.
 *
 * Every JSON response is `{ ok: true, value }` or `{ ok: false, error, stage }`,
 * so the panel can show kie.ai's own message and say which stage failed.
 */
/** Write a plain HTML document; used only by the API-doc route. */
function sendHtml(res, status, html) {
  const payload = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function createHandler(ctx, config) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = url.pathname.slice(ROUTE_PATH.length).replace(/^\/+/, '')

    const send = (body, status = 200, headers = {}) => {
      const isBinary = body instanceof Uint8Array
      const payload = isBinary ? body : JSON.stringify(body)
      res.writeHead(status, {
        'content-type': isBinary ? headers['content-type'] ?? 'application/octet-stream' : 'application/json; charset=utf-8',
        'content-length': String(isBinary ? payload.byteLength : Buffer.byteLength(payload)),
        'cache-control': 'no-store',
        ...headers,
      })
      res.end(payload)
    }

    try {
      if (method === 'stored') {
        // The client sends the reference fields it holds for the image, so the
        // read can be verified exactly as the store wrote it.
        const stored = await readStoredImage(ctx, {
          ref: {
            attachmentId: url.searchParams.get('id'),
            mediaType: url.searchParams.get('mediaType'),
            width: url.searchParams.get('width'),
            height: url.searchParams.get('height'),
            bytes: url.searchParams.get('bytes'),
            name: url.searchParams.get('name'),
          },
        })
        send(stored.bytes, 200, { 'content-type': stored.mediaType })
        return
      }

      // Stream a generated file through the Host so the browser never needs the
      // API key, and the 20-minute link stays server-side.
      if (method === 'download' || method === 'imageBytes') {
        // `download` saves to disk; `imageBytes` feeds "use as input" in the
        // panel. Both need bytes for an image the plugin may never have stored
        // (a failure before the attachment step), so both go through the
        // temporary link instead of assuming a durable attachment exists.
        const { url: link } = await downloadLink(ctx, config, { url: url.searchParams.get('url') })
        const response = await fetch(link)
        if (!response.ok) {
          send({ ok: false, error: `Could not fetch the download link (HTTP ${response.status}).` }, 400)
          return
        }
        const bytes = Buffer.from(await response.arrayBuffer())
        const mediaType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim()
        const name = clean(url.searchParams.get('name')) || 'kie-image'
        send(bytes, 200,
          method === 'download'
            ? {
                'content-type': mediaType,
                'content-disposition': `attachment; filename="${name.replace(/[^\w.-]+/g, '-')}"`,
              }
            : { 'content-type': mediaType },
        )
        return
      }

      if (req.method !== 'POST') {
        send({ ok: false, error: 'Use POST for this endpoint.' }, 405, { allow: 'POST' })
        return
      }

      const fn = METHODS[method]
      if (fn === undefined) {
        send({ ok: false, error: `Unknown method: ${method}` }, 404)
        return
      }

      const raw = await readBody(req)
      let args = {}
      if (raw.trim() !== '') {
        try {
          args = JSON.parse(raw)
        } catch {
          send({ ok: false, error: 'The request body was not JSON.' }, 400)
          return
        }
      }

      send({ ok: true, value: await fn(ctx, config, args) })
    } catch (error) {
      const stage = error instanceof StageError ? error.stage : undefined
      const retryable = error instanceof StageError ? error.retryable : false
      send(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(stage === undefined ? {} : { stage, retryable }),
        },
        400,
      )
    }
  }
}

/** Collect a request body with a bound, so a large upload cannot exhaust memory. */
function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(new Error('The request body was too large.'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Cordis plugin entry: publish the browser half's private API route.
 *
 * @param {object} ctx plugin context exposing `webServer`
 * @param {object} config resolved plugin config
 */
export function apply(ctx, config) {
  const resolved = config ?? {}
  const handler = createHandler(ctx, resolved)
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PATH,
        handler,
      }),
    'gpt-image-playground/api-route',
  )
  // The browser half is a separate bundle: this route is its only way back to
  // the Host. Every GET below answers a question the panel would otherwise
  // have to ask with a POST, which lets a human open the panel's own API in a
  // browser tab to check that this plugin is live (and that its untouched
  // Seedream sibling is not serving this path).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/gpt-image-playground',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            handler(req, res)
            return
          }
          sendHtml(res, 200, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GPT Image playground API</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:40px;max-width:760px;color:#1c1c1e}
h1{font-size:18px}
code{background:#f2f2f7;padding:1px 5px;border-radius:4px}
li{margin:4px 0}
</style>
</head>
<body>
<h1>GPT Image playground</h1>
<p>The Host half of this bundle is live. This document is served by
<code>dsh-gpt-image-playground</code>, not by the Seedream plugin.</p>
<p>Its panel talks to the Host over this route with <code>POST</code>:</p>
<ul>
<li><code>POST ${ROUTE_PATH}/status</code></li>
<li><code>POST ${ROUTE_PATH}/credits</code></li>
<li><code>POST ${ROUTE_PATH}/startJob</code></li>
<li><code>POST ${ROUTE_PATH}/cancelJob</code></li>
<li><code>POST ${ROUTE_PATH}/listHistory</code></li>
<li><code>POST ${ROUTE_PATH}/clearHistory</code></li>
<li><code>POST ${ROUTE_PATH}/removeHistory</code></li>
<li><code>POST ${ROUTE_PATH}/downloadLink</code></li>
<li><code>POST ${ROUTE_PATH}/setApiKey</code></li>
<li><code>POST ${ROUTE_PATH}/clearApiKey</code></li>
<li><code>GET  ${ROUTE_PATH}/stored?id=…&amp;mediaType=…&amp;width=…&amp;height=…&amp;bytes=…</code></li>
<li><code>GET  ${ROUTE_PATH}/imageBytes?url=…</code></li>
<li><code>GET  ${ROUTE_PATH}/download?url=…</code></li>
</ul>
</body>
</html>
`)
        },
      }),
    'gpt-image-playground/api-doc',
  )
}
