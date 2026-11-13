/**
 * Browser-half behaviour checks for the GPT Image bundle.
 *
 * Runs the real bundle under a small React stand-in and a scripted Host route.
 * The point is to prove the module contract, both slot registrations, both
 * tabs, and — most importantly — that panel state survives the unmount that
 * happens when the user switches to another sidebar entry.
 *
 * Run: node test/client.test.cjs
 */
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ---------------------------------------------------------------- React stub */

function makeReact() {
  // Hook state is keyed by component identity, not by one global cursor. The
  // test renderer invokes function components by calling them, so a flat cursor
  // would let one component's useState shift another component's slot index.
  const stores = new Map()
  let owner = null
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
    },
    /** Components call this around their body so hooks land in the right store. */
    __render(component, props) {
      const previousOwner = owner
      const previousCursor = cursor
      owner = component
      cursor = 0
      try {
        return component(props)
      } finally {
        owner = previousOwner
        cursor = previousCursor
      }
    },
    useState(initial) {
      const store = owner ? getStore(owner) : rootStore
      const index = cursor++
      if (store[index] === undefined) store[index] = typeof initial === 'function' ? initial() : initial
      return [
        store[index],
        (next) => {
          store[index] = typeof next === 'function' ? next(store[index]) : next
        },
      ]
    },
    useEffect(effect) {
      // Effects are not stateful here: run once per render, keep any cleanup.
      const dispose = effect()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    useMemo(factory) {
      return factory()
    },
    useCallback(fn) {
      return fn
    },
    useRef(value) {
      return { current: value }
    },
    __reset() {
      cursor = 0
    },
  }
  const rootStore = []
  function getStore(component) {
    let store = stores.get(component)
    if (!store) {
      store = []
      stores.set(component, store)
    }
    return store
  }
  return React
}

/* -------------------------------------------------- renderer / tree helpers */

// The stub in makeReact() owns hook storage; renderComponent routes every
// function-component invocation through it so hooks land in the right store.
let activeReact = null

function renderComponent(component, props) {
  if (activeReact && typeof activeReact.__render === 'function') {
    return activeReact.__render(component, props)
  }
  return component(props)
}

/** Flatten a rendered tree into element nodes so tests can find and act on them. */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') return out
  out.push(node)
  if (typeof node.type === 'function') {
    // Render through the stub so each component's hooks get their own store.
    flatten(renderComponent(node.type, node.props ?? {}), out)
    return out
  }
  flatten(node.props?.children, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  // Descend into function components, or the root element reads as empty.
  if (typeof node.type === 'function') return textOf(renderComponent(node.type, node.props ?? {}))
  return textOf(node.props?.children)
}

function findAll(tree, predicate) {
  return flatten(tree).filter(predicate)
}

function findButton(tree, label) {
  return findAll(tree, (node) => node.type === 'button' && textOf(node).includes(label))[0]
}

/* ---------------------------------------------------------------------- main */

async function main() {
  const React = makeReact()
  activeReact = React
  const registered = []
  const injected = []
  const styles = []
  const hostCalls = []
  const hostBodies = []

  /* ----------------------------------------------------- scripted Host route */

  const hostState = {
    configured: true,
    history: [],
    credits: 12.5,
  }

  const fetcher = async (url, init) => {
    const method = String(url).split('/').pop().split('?')[0]
    hostCalls.push(method)
    const body = init?.body ? JSON.parse(init.body) : {}
    hostBodies.push({ method, body })

    if (method === 'status') {
      return {
        json: async () => ({
          ok: true,
          value: {
            configured: hostState.configured,
            apiKeyEnv: 'KIE_API_KEY',
            defaultMode: 'text2image',
            aspectRatios: ['auto', '1:1', '16:9'],
            models: [
              {
                key: 'flare-text-to-image',
                id: 'gpt-image-2-6/flare-text-to-image',
                mode: 'text2image',
                label: 'GPT Image 2.6 Flare',
                version: '2.6 Flare',
                maxReferences: 0,
                minReferences: 0,
                sizes: ['1K', '2K', '4K'],
                aspectRatios: ['auto', '1:1', '3:2', '16:9'],
                formats: ['png', 'jpeg', 'webp'],
                backgrounds: ['auto', 'transparent', 'opaque'],
                qualities: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
                promptRequired: true,
                promptLimits: { min: 1, max: 32000 },
              },
              {
                key: 'sunburst-text-to-image',
                id: 'gpt-image-2-6/sunburst-text-to-image',
                mode: 'text2image',
                label: 'GPT Image 2.6 Sunburst',
                version: '2.6 Sunburst',
                maxReferences: 0,
                minReferences: 0,
                sizes: ['1K', '2K', '4K'],
                aspectRatios: ['auto', '1:1', '3:2'],
                formats: ['png', 'jpeg', 'webp'],
                backgrounds: ['auto', 'transparent', 'opaque'],
                qualities: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
                promptRequired: true,
                promptLimits: { min: 1, max: 32000 },
              },
              {
                key: 'economy-text-to-image',
                id: 'gpt-image-2-6/economy-text-to-image',
                mode: 'text2image',
                label: 'GPT Image 2.6 Economy',
                version: '2.6 Economy',
                maxReferences: 0,
                minReferences: 0,
                sizes: ['1K'],
                aspectRatios: ['auto', '1:1', '16:9'],
                formats: ['png'],
                backgrounds: ['auto', 'transparent', 'opaque'],
                qualities: [],
                promptRequired: true,
                promptLimits: { min: 1, max: 20000 },
              },
              {
                key: 'flare-image-to-image',
                id: 'gpt-image-2-6/flare-image-to-image',
                mode: 'image2image',
                label: 'GPT Image 2.6 Flare',
                version: '2.6 Flare',
                maxReferences: 16,
                minReferences: 1,
                sizes: ['1K', '2K', '4K'],
                aspectRatios: ['auto', '1:1', '3:2'],
                formats: ['png', 'jpeg', 'webp'],
                backgrounds: ['auto', 'transparent', 'opaque'],
                qualities: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
                promptRequired: true,
                promptLimits: { min: 1, max: 32000 },
              },
              {
                key: 'sunburst-image-to-image',
                id: 'gpt-image-2-6/sunburst-image-to-image',
                mode: 'image2image',
                label: 'GPT Image 2.6 Sunburst',
                version: '2.6 Sunburst',
                maxReferences: 16,
                minReferences: 1,
                sizes: ['1K', '2K', '4K'],
                aspectRatios: ['auto', '1:1', '3:2'],
                formats: ['png', 'jpeg', 'webp'],
                backgrounds: ['auto', 'transparent', 'opaque'],
                qualities: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
                promptRequired: true,
                promptLimits: { min: 1, max: 32000 },
              },
              {
                key: 'economy-image-to-image',
                id: 'gpt-image-2-6/economy-image-to-image',
                mode: 'image2image',
                label: 'GPT Image 2.6 Economy',
                version: '2.6 Economy',
                maxReferences: 16,
                minReferences: 1,
                sizes: ['1K'],
                aspectRatios: ['auto', '1:1'],
                formats: ['png'],
                backgrounds: ['auto', 'transparent', 'opaque'],
                qualities: [],
                promptRequired: true,
                promptLimits: { min: 1, max: 20000 },
              },
            ],
          },
        }),
      }
    }
    if (method === 'credits') {
      return { json: async () => ({ ok: true, value: { credits: hostState.credits } }) }
    }
    if (method === 'listHistory') {
      return { json: async () => ({ ok: true, value: { entries: hostState.history, running: [] } }) }
    }
    if (method === 'stored' || method === 'imageBytes') {
      // The panel fetches real bytes for the lightbox and for "Use as input".
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      return {
        ok: true,
        status: 200,
        blob: async () => ({ type: 'image/png', bytes }),
      }
    }
    return { json: async () => ({ ok: true, value: {} }) }
  }

  /* --------------------------------------------------------------- locale */

  const dictionary = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'locale', 'en.json'), 'utf8'),
  )
  const flat = {}
  for (const [section, entries] of Object.entries(dictionary)) {
    for (const [key, value] of Object.entries(entries)) flat[`${section}.${key}`] = value
  }
  // Mirrors ClientLocale: an unregistered key resolves to the key itself.
  const bind = () => (key) => flat[key] ?? key

  // What the client publishes through `ctx.locale.register`. The panel is dead
  // without it: `bind(ns)(key)` would hand back the key and the sidebar would
  // render "panel.title".
  const localeRegistrations = []

  /* ------------------------------------------------------------ module host */

  const ctx = {
    locale: {
      bind,
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
        return () => {}
      },
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject(name, callback) {
        injected.push(name)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }

  const documentStub = {
    createElement: () => ({ setAttribute() {}, remove() {}, textContent: '', style: {}, select() {} }),
    head: { appendChild: (tag) => styles.push(tag) },
    listeners: new Map(),
    addEventListener(type, handler) {
      if (!documentStub.listeners.has(type)) documentStub.listeners.set(type, new Set())
      documentStub.listeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      documentStub.listeners.get(type)?.delete(handler)
    },
    body: { appendChild() {}, removeChild() {} },
  }

  let loaded
  const windowStub = {
    __ModuleLoader__: { load: (spec) => (loaded = spec) },
    // The panel schedules its transient notes through window.setTimeout.
    setTimeout,
    clearTimeout,
  }

  // The bundle runs as a plain function body, so browser-only globals used
  // without a `window.` prefix (FileReader, Blob) must exist on globalThis.
  const previousFileReader = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      this.result = `data:${blob.type};base64,${Buffer.from(blob.bytes).toString('base64')}`
      // A real FileReader is async; resolve on the next tick so awaited callers
      // observe the loaded value rather than a synchronous surprise.
      setTimeout(() => this.onload?.(), 0)
    }
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8')
  const previousWindow = global.window
  const previousDocument = global.document
  global.window = windowStub
  global.document = documentStub

  let plugin
  try {
    new Function('window', 'fetch', source)(windowStub, fetcher)
    assert.ok(loaded, 'the bundle must call __ModuleLoader__.load')
    assert.strictEqual(loaded.id, 'dsh-gpt-image-playground')
    assert.strictEqual(typeof loaded.factory, 'function')

    plugin = loaded.factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    })
    assert.ok(plugin && typeof plugin.apply === 'function')
    assert.deepStrictEqual(plugin.inject, ['slots', 'locale'])
    plugin.apply(ctx)
  } catch (error) {
    global.window = previousWindow
    global.document = previousDocument
    globalThis.FileReader = previousFileReader
    throw error
  }
  // The panel is rendered further down, and mounting a result card installs a
  // document-level Escape handler, so the DOM stubs have to stay in place for
  // the whole run — not just while the bundle is loaded.
  const restoreGlobals = () => {
    global.window = previousWindow
    global.document = previousDocument
    globalThis.FileReader = previousFileReader
  }

  /* ------------------------------------------------------------- registration */

  assert.deepStrictEqual(injected, ['sidebar.panellist', 'main'], 'both slots are injected')
  assert.strictEqual(registered.length, 2)

  // The dictionary the client publishes must mirror locale/en.json exactly;
  // otherwise the sidebar and panel silently drift back to their keys.
  assert.strictEqual(localeRegistrations.length, 1, 'the client publishes its dictionary')
  assert.strictEqual(localeRegistrations[0].namespace, 'gpt-image-playground')
  const published = localeRegistrations[0].dictionaries.en
  assert.deepStrictEqual(
    Object.keys(published).sort(),
    Object.keys(flat).sort(),
    'registered keys match locale/en.json',
  )
  for (const [key, value] of Object.entries(flat)) {
    assert.strictEqual(published[key], value, `locale key "${key}" matches en.json`)
  }

  const icon = registered[0]
  assert.strictEqual(icon.options.name, 'sidebar.panellist')
  assert.strictEqual(icon.options.id, 'gpt-image-playground')
  assert.strictEqual(typeof icon.options.label, 'function', 'the label stays locale-reactive')
  assert.strictEqual(
    icon.options.label(),
    'GPT Image',
    'the sidebar label is the display title, never the locale key',
  )
  const iconTree = icon.component({ size: 20, active: true })
  assert.strictEqual(iconTree.type, 'svg')
  assert.strictEqual(iconTree.props.width, 20)

  const panel = registered[1]
  assert.strictEqual(panel.options.name, 'main')
  assert.strictEqual(panel.options.key, 'gpt-image-playground', 'panel key matches the sidebar id')

  /* -------------------------------------------------------------- first paint */

  React.__reset()
  let tree = panel.component({})
  let text = textOf(tree)

  for (const label of ['Text to image', 'Image to image']) {
    assert.ok(text.includes(label), `the panel offers "${label}"`)
  }
  assert.ok(!text.includes('Layer decomposition'), 'the layer tab is gone in the 2.6 plugin')
  assert.ok(text.includes('GPT Image'), 'the panel renders its title')
  assert.strictEqual(findAll(tree, (node) => node.type === 'textarea').length, 1, 'one prompt field')

  // Hydration reads status and the durable history from the Host.
  await sleep(30)
  React.__reset()
  tree = panel.component({})
  text = textOf(tree)
  assert.ok(hostCalls.includes('status'), 'the panel reads status')
  assert.ok(hostCalls.includes('listHistory'), 'the panel reads durable history')
  assert.ok(hostCalls.includes('credits'), 'the panel reads credits when configured')
  assert.ok(text.includes('12.5'), 'credits are shown')

  // Text to image: aspect ratio, resolution and format are all offered.
  const selects = findAll(tree, (node) => node.type === 'select')
  assert.ok(selects.length >= 3, 'ratio, size and format controls exist')
  assert.ok(text.includes('Aspect ratio'), 'aspect ratio is offered for text to image')
  assert.ok(text.includes('Quality'), 'the quality control exists for a model that supports it')
  assert.ok(!text.includes('NSFW check'), 'the Seedream nsfw toggle is gone')
  assert.ok(!/\b(tabs|fields|actions|status|panel)\.[a-z]/i.test(text), 'no untranslated key leaks')

  /* --------------------------------------------- choosing between the three tiers */

  const modelSelect = findAll(tree, (node) => node.props?.id === 'gpt-model')[0]
  assert.ok(modelSelect, 'a model dropdown is offered inside the text tab')
  assert.deepStrictEqual(
    modelSelect.props.children.map((option) => option.props.value),
    ['flare-text-to-image', 'sunburst-text-to-image', 'economy-text-to-image'],
    'all three text models are listed',
  )
  assert.strictEqual(modelSelect.props.value, 'flare-text-to-image', 'Flare is the default')

  const flareseSizes = findAll(tree, (node) => node.props?.id === 'gpt-size')[0]
  assert.deepStrictEqual(
    flareseSizes.props.children.map((option) => option.props.value),
    ['1K', '2K', '4K'],
    'Flare offers the full resolution ladder',
  )
  const flareFormats = findAll(tree, (node) => node.props?.id === 'gpt-format')[0]
  assert.deepStrictEqual(
    flareFormats.props.children.map((option) => option.props.value),
    ['png', 'jpeg', 'webp'],
    'Flare offers all three formats',
  )
  assert.strictEqual(
    findAll(tree, (node) => node.props?.id === 'gpt-quality').length,
    1,
    'Flare shows the quality control',
  )

  // Switching to Economy must reshape the options the model cannot accept.
  modelSelect.props.onChange({ target: { value: 'economy-text-to-image' } })
  await sleep(10)
  React.__reset()
  tree = panel.component({})
  const switched = findAll(tree, (node) => node.props?.id === 'gpt-model')[0]
  assert.strictEqual(switched.props.value, 'economy-text-to-image', 'the choice is kept in the store')
  const economySizes = findAll(tree, (node) => node.props?.id === 'gpt-size')[0]
  assert.deepStrictEqual(
    economySizes.props.children.map((option) => option.props.value),
    ['1K'],
    'Economy is 1K only',
  )
  const economyFormats = findAll(tree, (node) => node.props?.id === 'gpt-format')[0]
  assert.deepStrictEqual(
    economyFormats.props.children.map((option) => option.props.value),
    ['png'],
    'Economy is PNG only',
  )
  assert.strictEqual(
    findAll(tree, (node) => node.props?.id === 'gpt-quality').length,
    0,
    'Economy hides the quality control it does not accept',
  )
  assert.ok(textOf(tree).includes('0 / 20000 characters'), `the counter reflects the Economy prompt cap, got: ${textOf(tree).slice(0,200)}`)

  // Back to Flare for the submission check.
  const flareOption = findAll(panel.component({}), (node) => node.props?.id === 'gpt-model')[0]
  flareOption.props.onChange({ target: { value: 'flare-text-to-image' } })
  await sleep(10)
  React.__reset()
  tree = panel.component({})

  // The chosen model must reach the Host, not the tab default.
  const generate = findButton(tree, 'Generate')
  assert.ok(generate, 'the generate button is present')
  hostBodies.length = 0
  generate.props.onClick()
  await sleep(30)
  React.__reset()
  tree = panel.component({})
  assert.ok(hostBodies.some((entry) => entry.method === 'startJob'), 'generating calls startJob')
  const submitted = hostBodies.filter((entry) => entry.method === 'startJob').pop()
  assert.strictEqual(submitted.body.model, 'flare-text-to-image', 'the selected model is submitted')
  assert.strictEqual(submitted.body.mode, 'text2image', 'the tab is kept')
  assert.strictEqual(submitted.body.quality, 'medium', 'the quality default is submitted')

  /* ------------------------------------------ state survives panel unmounting */

  const textarea = findAll(tree, (node) => node.type === 'textarea')[0]
  textarea.props.onChange({ target: { value: 'a brass desk lamp on walnut' } })

  // Simulate the sidebar unmounting the panel and mounting it again later.
  React.__reset()
  tree = panel.component({})
  const restored = findAll(tree, (node) => node.type === 'textarea')[0]
  assert.strictEqual(
    restored.props.value,
    'a brass desk lamp on walnut',
    'the prompt survives an unmount/remount instead of resetting',
  )

  /* ------------------------------------------------ switching mode reshapes UI */

  const editTab = findButton(tree, 'Image to image')
  assert.ok(editTab, 'the image-to-image tab is present')
  editTab.props.onClick()
  await sleep(10)
  React.__reset()
  tree = panel.component({})
  text = textOf(tree)

  assert.ok(text.includes('Reference images'), 'the edit tab asks for source images')
  assert.ok(!text.includes('Source image\n'), 'the plural picker is used, not the singular one')
  assert.ok(text.includes('Aspect ratio'), 'the edit tab keeps the aspect ratio control')
  assert.ok(text.includes('Quality'), 'the edit tab keeps the quality control')

  // Back to text to image for the remaining checks.
  const t2iTab = findButton(tree, 'Text to image')
  t2iTab.props.onClick()
  await sleep(10)
  React.__reset()
  tree = panel.component({})

  /* --------------------------------------------------------- results and links */

  hostState.history = [
    {
      id: 'job_1',
      mode: 'text2image',
      model: 'gpt-image-2-6/flare-text-to-image',
      label: 'GPT Image 2.6 Flare',
      prompt: 'separate the parrot',
      aspectRatio: 'auto',
      size: '2K',
      format: 'png',
      quality: 'high',
      state: 'done',
      creditsConsumed: 2.5,
      images: [
        {
          name: 'gpt-image-1.png',
          url: 'https://tempfile.test/out-1.png',
          saved: true,
          mediaType: 'image/png',
          ref: { attachmentId: 'att_1', mediaType: 'image/png', width: 1024, height: 1024, bytes: 4096, name: 'gpt-image-1.png' },
        },
        {
          name: 'gpt-image-2.png',
          url: 'https://tempfile.test/out-2.png',
          saved: true,
          mediaType: 'image/png',
          ref: {
            attachmentId: 'att_2',
            mediaType: 'image/png',
            width: 1024,
            height: 1024,
            bytes: 4096,
            name: 'gpt-image-2.png',
          },
        },
      ],
    },
  ]
  await panel.component({}) // let the hydration effect re-read history
  await sleep(30)
  // Traversing the tree is what actually invokes the component (and its
  // effects), so force a mount, let the Host read resolve, then render again.
  void textOf(panel.component({}))
  await sleep(60)
  React.__reset()
  tree = panel.component({})
  text = textOf(tree)

  // The gallery is one card per entry, carrying its prompt and full metadata.
  assert.ok(text.includes('Gallery (1)'), 'every history entry becomes a gallery card')
  assert.ok(!text.includes('History ('), 'the standalone history list is gone')
  assert.ok(text.includes('separate the parrot'), 'the card carries its prompt')
  assert.ok(text.includes('2 image(s)'), 'the card reports how many images it holds')
  assert.ok(text.includes('2.5 credits'), 'the card reports the credits consumed')
  assert.ok(!text.includes('Base image'), 'the layer labelling is gone with the layer mode')

  const cards = findAll(tree, (node) => String(node.props?.className ?? '').includes('gpt-gal-card'))
  assert.strictEqual(cards.length, 1, 'one card per entry, not one card per image')

  const images = findAll(tree, (node) => node.type === 'img')
  // The reference has to travel with the request: the Host re-verifies media
  // type, byte length and dimensions on every read, so an id alone is rejected.
  const storedSrcs = images.map((node) => String(node.props.src)).filter((src) => src.includes('/stored?'))
  assert.strictEqual(storedSrcs.length, 1, 'the card shows the cover image; siblings wait in the lightbox')
  const coverSrc = storedSrcs[0]
  assert.ok(coverSrc.includes('id=att_1'), 'the attachment id is sent')
  assert.ok(coverSrc.includes('mediaType=image%2Fpng'), 'the media type is sent')
  assert.ok(coverSrc.includes('width=1024') && coverSrc.includes('height=1024'), 'the dimensions are sent')
  assert.ok(coverSrc.includes('bytes=4096'), 'the byte length is sent')

  // The cover is clickable and opens the full-size overlay.
  const zoomable = findAll(tree, (node) => node.type === 'button' && String(node.props.className).includes('gpt-zoomable'))
  assert.strictEqual(zoomable.length, 1, 'the cover can be expanded')

  const useButtons = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('Use as input'))
  assert.strictEqual(useButtons.length, 1, 'the card offers "Use as input"')

  const copyButtons = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('Copy prompt'))
  assert.ok(copyButtons.length >= 1, 'the prompt can be copied for reuse')

  const downloads = findAll(tree, (node) => node.type === 'a' && String(node.props.href).includes('/download?'))
  assert.strictEqual(downloads.length, 1, 'the card has a Host-proxied download link')
  assert.ok(String(downloads[0].props.href).includes('https%3A%2F%2Ftempfile.test'), 'the link carries the result URL')

  /* ---------------------------------------------- lightbox and "use as input" */

  // Clicking the cover opens the full-size overlay (a dialog with the image).
  // The whole panel is re-rendered with the SAME hook storage: a real remount
  // would drop local state, and the lightbox lives in local state.
  zoomable[0].props.onClick()
  React.__reset()
  const zoomed = panel.component({})
  const dialogs = findAll(zoomed, (node) => node.props?.role === 'dialog')
  assert.strictEqual(dialogs.length, 1, 'clicking a card opens the lightbox')
  const zoomedImages = findAll(zoomed, (node) => node.type === 'img' && String(node.props.src).includes('/stored?'))
  assert.strictEqual(zoomedImages.length, 2, 'the lightbox adds its own full-size image beside the card cover')

  // A multi-image entry: Next walks to the second one and the bar names it.
  const nextButton = findAll(zoomed, (node) => node.type === 'button' && String(node.props.className).includes('gpt-lightbox-next'))[0]
  assert.ok(nextButton, 'multi-image entries get a next control')
  nextButton.props.onClick()
  React.__reset()
  const navigated = panel.component({})
  assert.ok(textOf(navigated).includes('gpt-image-2.png'), 'naming the image shown in the lightbox')
  assert.ok(textOf(navigated).includes('2 / 2'), 'the position within the entry is shown')

  // "Use as input" fetches the bytes and loads them into the source input.
  const fetchesBefore = hostCalls.length
  const useButton = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('Use as input'))[0]
  await useButton.props.onClick()
  await sleep(30)
  assert.ok(hostCalls.length > fetchesBefore, 'the bytes are fetched through the Host')

  React.__reset()
  const afterUse = panel.component({})
  const refThumbs = findAll(afterUse, (node) => node.type === 'img' && String(node.props.src).startsWith('data:'))
  assert.ok(refThumbs.length >= 1, 'the result is loaded into the source-image input as data')
  const afterText = textOf(afterUse)
  assert.ok(
    afterText.includes('Sent to the image input.') || afterText.includes('Image to image'),
    'the panel confirms the handoff or switches to the editing mode',
  )

  void downloads

  /* ------------------------------------------------------------- key handling */

  hostState.configured = false
  void textOf(panel.component({}))
  await sleep(60)
  React.__reset()
  const unconfigured = panel.component({})
  const password = findAll(unconfigured, (node) => node.type === 'input' && node.props.type === 'password')
  assert.ok(password.length === 1, 'an unconfigured panel offers a key field')

  /* ------------------------------------------------------------------ styles */

  assert.strictEqual(styles.length, 1, 'one stylesheet is installed')
  assert.ok(styles[0].textContent.includes('--dsw-alias-'), 'styles use Harness theme tokens')

  console.log(
    'client checks passed · slots:',
    injected.join(', '),
    '· host calls:',
    [...new Set(hostCalls)].join(','),
  )
  restoreGlobals()
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('FAILED:', error && error.stack ? error.stack : error)
    process.exit(1)
  },
)
