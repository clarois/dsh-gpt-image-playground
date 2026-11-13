/**
 * Host-half behaviour checks for the GPT Image bundle.
 *
 * These run under plain Node with stand-ins for the Harness services the plugin
 * injects, and a scripted fetch that imitates kie.ai's wire format — including
 * the trap that it answers HTTP 200 even when the request failed.
 *
 * Run: node test/host.test.cjs
 */
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const API = 'https://api.kie.ai'
const UPLOAD = 'https://kieai.redpanda.co'

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(store, id, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await store.list()
    const entry = value.find((item) => item.id === id)
    if (entry !== undefined && entry.state !== 'running') return entry
    if (Date.now() > deadline) return entry
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-image-test-'))
  process.env.DSH_HOME = home

  const host = await import(pathToFileURL(path.join(__dirname, '..', 'index.js')).href)

  /* --------------------------------------------------------------- fixtures */

  const secrets = new Map([['KIE_API_KEY', 'test-key']])
  const attachments = new Map()
  let attachmentSeq = 0
  const savedNames = []
  const savedImages = []

  const ctx = {
    get(name) {
      if (name === 'credentials') {
        return {
          resolve: async (env) => (secrets.has(env) ? { value: secrets.get(env), source: 'store' } : undefined),
          describe: async (env) => ({
            configured: secrets.has(env),
            source: secrets.has(env) ? 'store' : undefined,
            writable: true,
          }),
          set: async (env, value) => secrets.set(env, value),
          unset: async (env) => secrets.delete(env),
        }
      }
      if (name === 'attachments') {
        return {
          saveImage: async (input) => {
            const id = `att_${++attachmentSeq}`
            const mediaType = input.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
            const ref = {
              attachmentId: id,
              mediaType,
              bytes: input.data.byteLength,
              width: input.width > 0 ? input.width : 1,
              height: input.height > 0 ? input.height : 1,
              ...(input.name ? { name: input.name } : {}),
            }
            attachments.set(id, { data: input.data, ref })
            savedNames.push(input.name)
            savedImages.push({ ref })
            return ref
          },
          // Mirrors the real service: the whole reference is verified on read,
          // so an incomplete or edited reference fails as corrupt.
          readImage: async (ref) => {
            const found = attachments.get(ref.attachmentId)
            if (found === undefined) throw new Error(`no attachment ${ref.attachmentId}`)
            const stored = found.ref
            if (
              stored.mediaType !== ref.mediaType ||
              stored.bytes !== ref.bytes ||
              stored.width !== ref.width ||
              stored.height !== ref.height
            ) {
              const error = new Error('Stored attachment metadata does not match its reference.')
              error.name = 'AttachmentError'
              error.code = 'ATTACHMENT_CORRUPT'
              throw error
            }
            return { data: found.data, ref: { ...stored, name: ref.name ?? stored.name } }
          },
        }
      }
      return undefined
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register(route) {
        ctx.__route = route
        return () => {
          ctx.__route = undefined
        }
      },
    },
  }

  const CFG = { apiBase: API, uploadBase: UPLOAD, pollStartMs: 25 }
  host.apply(ctx, CFG)
  assert.ok(ctx.__route, 'apply must register the API route')
  assert.strictEqual(ctx.__route.kind, 'prefix')
  assert.strictEqual(ctx.__route.path, '/gpt-image-playground/api')
  assert.strictEqual(typeof ctx.__route.handler, 'function')

  /* ------------------------------------------------- request validation (pure) */

  const t2i = host.normalizeRequest({ mode: 'text2image', prompt: 'a red apple', aspectRatio: '16:9', size: '2K', format: 'jpeg' })
  assert.strictEqual(t2i.model, 'gpt-image-2-6/flare-text-to-image', 'the first entry of a tab is the default')
  assert.strictEqual(t2i.modelKey, 'flare-text-to-image')
  assert.strictEqual(t2i.aspectRatio, '16:9')
  assert.strictEqual(t2i.size, '2K')
  assert.strictEqual(t2i.format, 'jpeg')
  assert.strictEqual(t2i.background, 'auto', 'Flare defaults the background to auto')
  assert.strictEqual(t2i.quality, 'medium', 'Flare defaults the quality to medium')

  const economy = host.normalizeRequest({
    mode: 'text2image',
    model: 'economy-text-to-image',
    prompt: 'a red apple',
    aspectRatio: '16:9',
  })
  assert.strictEqual(economy.model, 'gpt-image-2-6/economy-text-to-image')
  assert.strictEqual(economy.size, '1K', 'Economy is 1K only')
  assert.strictEqual(economy.format, 'png', 'Economy is PNG only')
  assert.strictEqual(economy.quality, '', 'Economy takes no quality control')

  const sunburst = host.normalizeRequest({
    mode: 'text2image',
    model: 'sunburst-text-to-image',
    prompt: 'a chrome teapot',
    size: '4K',
    quality: 'xhigh',
  })
  assert.strictEqual(sunburst.model, 'gpt-image-2-6/sunburst-text-to-image')
  assert.strictEqual(sunburst.quality, 'xhigh')

  const edit = host.normalizeRequest({
    mode: 'image2image',
    prompt: 'make it blue',
    references: ['data:image/png;base64,AAAA'],
  })
  assert.strictEqual(edit.model, 'gpt-image-2-6/flare-image-to-image', 'the edit tab defaults to Flare')
  assert.strictEqual(edit.background, 'auto')

  const rejects = (input, re) => assert.throws(() => host.normalizeRequest(input), re)

  rejects({ mode: 'text2image', prompt: '' }, /prompt is required/i)
  rejects({ mode: 'text2image', model: 'economy-text-to-image', prompt: 'x'.repeat(20001) }, /between 1 and 20000/i)
  rejects({ mode: 'text2image', prompt: 'x'.repeat(32001) }, /between 1 and 32000/i)
  rejects({ mode: 'text2image', prompt: 'a red apple', aspectRatio: '7:3' }, /not a supported aspect ratio/i)
  rejects({ mode: 'text2image', prompt: 'a red apple', size: '8K' }, /not a supported resolution/i)
  rejects({ mode: 'text2image', model: 'economy-text-to-image', prompt: 'a red apple', size: '2K' }, /not a supported resolution/i)
  rejects({ mode: 'text2image', prompt: 'a red apple', format: 'gif' }, /not a supported output format/i)
  rejects({ mode: 'text2image', model: 'economy-text-to-image', prompt: 'a red apple', format: 'jpeg' }, /not a supported output format/i)
  rejects({ mode: 'text2image', prompt: 'a red apple', quality: 'ultra' }, /not a supported quality/i)
  rejects({ mode: 'text2image', prompt: 'a red apple', background: 'rainbow' }, /not a supported background/i)
  rejects({ mode: 'image2image', prompt: 'a red apple' }, /needs at least one source image/i)
  rejects({ mode: 'image2image', prompt: 'a red apple', references: new Array(17).fill('data:,x') }, /at most 16/i)
  rejects({ mode: 'nope', prompt: 'a red apple' }, /Unknown mode/i)
  // Economy has no ratio outside its own list.
  rejects({ mode: 'text2image', model: 'economy-text-to-image', prompt: 'a red apple', aspectRatio: '5:4' }, /not a supported aspect ratio/i)
  // The 2.6 doc allows transparent for PNG and WebP only.
  rejects(
    { mode: 'text2image', prompt: 'a red apple', format: 'jpeg', background: 'transparent' },
    /transparent background requires the PNG or webp format/i,
  )
  // An unknown key falls back to the tab default rather than failing the job.
  assert.strictEqual(
    host.normalizeRequest({ mode: 'text2image', model: 'gpt-9', prompt: 'a red apple' }).modelKey,
    'flare-text-to-image',
  )

  /* -------------------------------------------------------- scripted kie.ai wire */

  let createCalls = []
  let uploadCalls = []
  let pollStates = []
  let pollIndex = 0
  let failWith = null

  global.fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    if (url.startsWith(`${UPLOAD}/api/file-base64-upload`)) {
      const body = JSON.parse(init.body)
      uploadCalls.push(body)
      return jsonResponse({
        success: true,
        code: 200,
        msg: 'File upload successful',
        data: { downloadUrl: `https://uploaded.test/${body.fileName}` },
      })
    }

    if (url.startsWith(`${API}/api/v1/jobs/createTask`) && method === 'POST') {
      const body = JSON.parse(init.body)
      createCalls.push(body)
      if (failWith !== null) return jsonResponse(failWith)
      return jsonResponse({ code: 200, msg: 'success', data: { taskId: 'task_1' } })
    }

    if (url.startsWith(`${API}/api/v1/jobs/recordInfo`)) {
      const state = pollStates[Math.min(pollIndex, pollStates.length - 1)]
      pollIndex += 1
      if (state === 'success') {
        return jsonResponse({
          code: 200,
          msg: 'success',
          data: {
            taskId: 'task_1',
            state: 'success',
            resultJson: JSON.stringify({ resultUrls: ['https://tempfile.test/out.png'] }),
            creditsConsumed: 2.5,
            costTime: 12,
          },
        })
      }
      if (state === 'fail') {
        return jsonResponse({
          code: 200,
          msg: 'success',
          data: { taskId: 'task_1', state: 'fail', failCode: '500', failMsg: 'content blocked' },
        })
      }
      return jsonResponse({ code: 200, msg: 'success', data: { taskId: 'task_1', state } })
    }

    if (url.startsWith(`${API}/api/v1/chat/credit`)) {
      return jsonResponse({ code: 200, msg: 'success', data: 42.75 })
    }

    if (url.startsWith(`${API}/api/v1/common/download-url`)) {
      const body = JSON.parse(init.body)
      return jsonResponse({ code: 200, msg: 'success', data: `https://download.test/${encodeURIComponent(body.url)}` })
    }

    // Result bytes.
    return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
  }

  /* --------------------------------------------------------- text to image job */

  pollStates = ['waiting', 'queuing', 'generating', 'success']
  pollIndex = 0
  uploadCalls = []
  createCalls = []

  const started = await host.startJob(ctx, CFG, {
    mode: 'text2image',
    prompt: 'a red apple on a wooden table',
    aspectRatio: '3:2',
    size: '1K',
    format: 'png',
  })
  assert.ok(started.jobId, 'startJob returns a job id immediately')

  const running = await host.listHistory()
  assert.ok(running.running.includes(started.jobId), 'the job is listed as running at once')
  const runningEntry = running.entries.find((entry) => entry.id === started.jobId)
  assert.strictEqual(runningEntry.state, 'running')
  assert.strictEqual(runningEntry.prompt, 'a red apple on a wooden table')

  const store = { list: async () => (await host.listHistory()).entries }
  const done = await waitFor(store, started.jobId)
  assert.strictEqual(done.state, 'done', done.error)

  assert.strictEqual(createCalls.length, 1)
  assert.strictEqual(createCalls[0].model, 'gpt-image-2-6/flare-text-to-image')
  assert.deepStrictEqual(createCalls[0].input, {
    prompt: 'a red apple on a wooden table',
    aspect_ratio: '3:2',
    resolution: '1K',
    output_format: 'png',
    background: 'auto',
    quality: 'medium',
  }, 'text to image sends no reference images and no nsfw checker')
  assert.strictEqual(uploadCalls.length, 0, 'text to image uploads nothing')
  assert.strictEqual(done.images.length, 1)
  assert.strictEqual(done.images[0].saved, true, 'the result is stored as a durable attachment')
  assert.strictEqual(done.creditsConsumed, 2.5)
  assert.strictEqual(done.modelKey, 'flare-text-to-image', 'the resolved key is recorded for the panel')
  assert.strictEqual(done.quality, 'medium')
  assert.ok(/^gpt-image-/.test(done.images[0].name), `result is named for the plugin, got ${done.images[0].name}`)

  /* ------------------------------------------------- text to image on Economy */

  createCalls = []
  pollIndex = 0
  const startedEco = await host.startJob(ctx, CFG, {
    mode: 'text2image',
    model: 'economy-text-to-image',
    prompt: 'a flat vector icon of a kettle',
  })
  const doneEco = await waitFor(store, startedEco.jobId)
  assert.strictEqual(doneEco.state, 'done', doneEco.error)
  assert.strictEqual(createCalls[0].model, 'gpt-image-2-6/economy-text-to-image', 'the Economy endpoint is used')
  assert.deepStrictEqual(createCalls[0].input, {
    prompt: 'a flat vector icon of a kettle',
    aspect_ratio: 'auto',
    resolution: '1K',
    output_format: 'png',
    background: 'auto',
  }, 'Economy sends no quality field at all')
  assert.strictEqual(doneEco.modelKey, 'economy-text-to-image')

  /* ------------------------------------------------------------- credits route */

  const credits = await host.credits(ctx, CFG)
  assert.strictEqual(credits.credits, 42.75)

  /* -------------------------------------------------------------- download link */

  const link = await host.downloadLink(ctx, CFG, { url: 'https://tempfile.test/out.png' })
  assert.ok(link.url.startsWith('https://download.test/'), 'download-url is minted through kie.ai')
  assert.strictEqual(link.expiresInMinutes, 20)

  /* ---------------------------------------------------- image to image job */

  pollStates = ['success']
  pollIndex = 0
  uploadCalls = []
  createCalls = []

  const editJob = await host.startJob(ctx, CFG, {
    mode: 'image2image',
    prompt: 'make the apple blue',
    aspectRatio: '1:1',
    references: ['data:image/png;base64,' + Buffer.from([1, 2, 3]).toString('base64')],
  })
  const edited = await waitFor({ list: async () => (await host.listHistory()).entries }, editJob.jobId)
  assert.strictEqual(edited.state, 'done', edited.error)

  assert.strictEqual(uploadCalls.length, 1, 'the reference is uploaded first')
  assert.strictEqual(uploadCalls[0].base64Data.startsWith('data:image/png;base64,'), true)
  assert.strictEqual(createCalls[0].input.input_urls.length, 1, 'the uploaded URL is passed as input_urls')
  assert.ok(createCalls[0].input.input_urls[0].startsWith('https://uploaded.test/'))
  assert.strictEqual(createCalls[0].input.aspect_ratio, '1:1')
  assert.strictEqual(createCalls[0].input.image_urls, undefined, 'the Seedream key name is gone')

  /* -------------------------------------------------------- error propagation */

  pollStates = ['fail']
  pollIndex = 0
  const failJob = await host.startJob(ctx, CFG, { mode: 'text2image', prompt: 'a red apple' })
  const failed = await waitFor({ list: async () => (await host.listHistory()).entries }, failJob.jobId)
  assert.strictEqual(failed.state, 'error')
  assert.strictEqual(failed.stage, 'generate', 'a task failure is tagged to the generate stage')
  assert.match(failed.error, /content blocked/)

  // kie.ai reports failures with HTTP 200 and a non-200 `code`.
  failWith = { code: 402, msg: 'Insufficient Credits', data: null }
  const rejected = await host.startJob(ctx, CFG, { mode: 'text2image', prompt: 'a red apple' })
  const rejectedEntry = await waitFor({ list: async () => (await host.listHistory()).entries }, rejected.jobId)
  assert.strictEqual(rejectedEntry.state, 'error')
  assert.strictEqual(rejectedEntry.stage, 'create')
  assert.match(rejectedEntry.error, /402: Insufficient Credits/, 'the code and message survive')
  failWith = null

  /* ---------------------------------------------------------- history surface */

  const before = (await host.listHistory()).entries.length
  assert.ok(before >= 4, 'every job is recorded')
  assert.ok(
    fs.existsSync(path.join(home, 'gpt-image-playground', 'history.json')),
    'history is persisted to disk so a page reload sees it',
  )

  const firstId = (await host.listHistory()).entries[0].id
  await host.removeHistory({ id: firstId })
  assert.strictEqual((await host.listHistory()).entries.length, before - 1, 'one entry can be removed')

  await host.clearHistory()
  assert.strictEqual((await host.listHistory()).entries.length, 0, 'history can be cleared')

  /* ------------------------------------------------------------------ routes */

  const invoke = (pathname, { method = 'POST', body } = {}) =>
    new Promise((resolve) => {
      const listeners = {}
      const req = {
        method,
        url: pathname,
        on(event, fn) {
          ;(listeners[event] ??= []).push(fn)
          return req
        },
        destroy() {},
      }
      const res = {
        status: 0,
        headers: {},
        body: undefined,
        writeHead(status, headers) {
          this.status = status
          this.headers = headers ?? {}
        },
        end(payload) {
          for (const fn of listeners.end ?? []) fn()
          resolve({ status: this.status, headers: this.headers, body: payload })
        },
      }
      void ctx.__route.handler(req, res)
      queueMicrotask(() => {
        if (body !== undefined) for (const fn of listeners.data ?? []) fn(Buffer.from(body))
        for (const fn of listeners.end ?? []) fn()
      })
    })

  const statusRoute = await invoke('/gpt-image-playground/api/status', { body: '{}' })
  const statusBody = JSON.parse(statusRoute.body)
  assert.strictEqual(statusRoute.status, 200)
  assert.strictEqual(statusBody.value.configured, true)
  assert.strictEqual(statusBody.value.models.length, 6)
  const textModels = statusBody.value.models.filter((model) => model.mode === 'text2image')
  assert.deepStrictEqual(
    textModels.map((model) => model.key),
    ['flare-text-to-image', 'sunburst-text-to-image', 'economy-text-to-image'],
    'all three text models are offered, Flare first as the default',
  )
  const editModels = statusBody.value.models.filter((model) => model.mode === 'image2image')
  assert.deepStrictEqual(
    editModels.map((model) => model.key),
    ['flare-image-to-image', 'sunburst-image-to-image', 'economy-image-to-image'],
    'the edit tab mirrors the same three tiers',
  )
  assert.deepStrictEqual(statusBody.value.models.map((model) => model.mode).filter((mode, index, all) => all.indexOf(mode) === index), ['text2image', 'image2image'], 'there is no layer tab any more')

  const flare = textModels[0]
  assert.deepStrictEqual(flare.qualities, ['low', 'medium', 'high', 'xhigh', 'max', 'auto'])
  assert.deepStrictEqual(flare.sizes, ['1K', '2K', '4K'], 'Flare has no 1.5K tier but adds 4K')
  assert.deepStrictEqual(flare.formats, ['png', 'jpeg', 'webp'])
  assert.ok(flare.aspectRatios.includes('auto'), 'Flare can derive the ratio from the input')
  assert.strictEqual(flare.maxReferences, 0, 'text to image takes no references')
  assert.strictEqual(flare.promptRequired, true)
  assert.deepStrictEqual(flare.promptLimits, { min: 1, max: 32000 })
  assert.strictEqual(flare.backgrounds.includes('transparent'), true)
  assert.strictEqual(flare.nsfw, undefined, 'the Seedream nsfw flag is gone')

  const economyModel = textModels[2]
  assert.deepStrictEqual(economyModel.sizes, ['1K'], 'Economy is 1K only')
  assert.deepStrictEqual(economyModel.formats, ['png'], 'Economy is PNG only')
  assert.deepStrictEqual(economyModel.qualities, [], 'Economy advertises no quality control')
  assert.deepStrictEqual(economyModel.promptLimits, { min: 1, max: 20000 })
  assert.deepStrictEqual(economyModel.aspectRatios, ['auto', '1:1', '16:9', '9:16', '3:2', '2:3', '21:9', '4:3'])

  const editFlare = editModels[0]
  assert.strictEqual(editFlare.minReferences, 1)
  assert.strictEqual(editFlare.maxReferences, 16)

  assert.strictEqual(statusBody.value.apiKeyEnv, 'KIE_API_KEY')
  assert.strictEqual(statusBody.value.defaultMode, 'text2image')

  const badMethod = await invoke('/gpt-image-playground/api/nope', { body: '{}' })
  assert.strictEqual(badMethod.status, 404)

  const wrongVerb = await invoke('/gpt-image-playground/api/status', { method: 'GET' })
  assert.strictEqual(wrongVerb.status, 405)

  const invalid = await invoke('/gpt-image-playground/api/startJob', { body: JSON.stringify({ mode: 'text2image', prompt: '' }) })
  assert.strictEqual(invalid.status, 400)
  assert.match(JSON.parse(invalid.body).error, /prompt is required/i)

  // A stored attachment is served back so results survive the temp URL expiring.
  // The read is verified against the recorded reference, so the id alone is not
  // enough: media type, byte length and dimensions travel with the request.
  const storedId = [...attachments.keys()][0]
  const bare = await invoke(`/gpt-image-playground/api/stored?id=${encodeURIComponent(storedId)}`, { method: 'GET' })
  assert.strictEqual(bare.status, 400, 'an id without its reference metadata is rejected')

  const storedEntry = savedImages.find((image) => image.ref?.attachmentId === storedId)
  assert.ok(storedEntry, 'the saved image carries a complete reference')
  assert.ok(storedEntry.ref.width > 0 && storedEntry.ref.height > 0 && storedEntry.ref.bytes > 0)
  const query = new URLSearchParams({ id: storedId })
  for (const key of ['mediaType', 'width', 'height', 'bytes', 'name']) {
    if (storedEntry.ref[key] !== undefined && storedEntry.ref[key] !== '') query.set(key, String(storedEntry.ref[key]))
  }
  const storedRes = await invoke(`/gpt-image-playground/api/stored?${query.toString()}`, { method: 'GET' })
  assert.strictEqual(storedRes.status, 200)
  assert.strictEqual(storedRes.headers['content-type'], storedEntry.ref.mediaType)
  assert.strictEqual(storedRes.body.length, storedEntry.ref.bytes, 'served bytes match the recorded length')

  // A tampered dimension must be refused rather than silently served.
  const tampered = new URLSearchParams(query)
  tampered.set('width', String(storedEntry.ref.width + 1))
  const tamperedRes = await invoke(`/gpt-image-playground/api/stored?${tampered.toString()}`, { method: 'GET' })
  assert.strictEqual(tamperedRes.status, 400, 'a mismatched reference is rejected')

  fs.rmSync(home, { recursive: true, force: true })
  console.log(`host checks passed · jobs recorded · attachments saved: ${savedNames.length}`)
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('FAILED:', error && error.stack ? error.stack : error)
    process.exit(1)
  },
)
