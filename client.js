/**
 * Browser half of the GPT Image bundle.
 *
 * Registers two slots:
 *   `sidebar.panellist` — the left-bar entry (icon + label).
 *   `main`              — the panel body the sidebar opens for that id.
 *
 * All kie.ai traffic goes through the Host half's same-origin route, because the
 * API sends no CORS headers and the API key must never reach the page.
 *
 * Panel state lives in a module-scope store rather than in component state: the
 * sidebar unmounts this panel whenever the user selects another entry, and any
 * `useState` would be discarded the moment they glance at Chat.
 */

window.__ModuleLoader__.load({
  id: 'dsh-gpt-image-playground',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'gpt-image-playground'
    const ROUTE = '/gpt-image-playground/api'
    const LOCALE_NS = 'gpt-image-playground'

    /**
     * The client must publish its own dictionary with `ctx.locale.register`;
     * `locale/en.json` alone is only read by the plugin manager for the card.
     * Without this, `bind(ns)(key)` returns the key itself and the sidebar
     * would literally read "panel.title". `test/client.test.cjs` keeps this in
     * sync with locale/en.json.
     */
    const LOCALE = {
      en: {
        'meta.title': 'GPT Image',
        'meta.description':
          'Generates and edits images with GPT Image 2.6 Flare, Sunburst and Economy on kie.ai.',
        'panel.title': 'GPT Image',
        'tabs.text2image': 'Text to image',
        'tabs.image2image': 'Image to image',
        'fields.prompt': 'Prompt',
        'fields.aspectRatio': 'Aspect ratio',
        'fields.size': 'Resolution',
        'fields.format': 'Format',
        'fields.quality': 'Quality',
        'fields.model': 'Model',
        'fields.background': 'Background',
        'fields.sourceImage': 'Source image',
        'fields.referenceImages': 'Reference images',
        'actions.generate': 'Generate',
        'actions.edit': 'Edit image',
        'actions.cancel': 'Cancel',
        'actions.retry': 'Retry',
        'actions.download': 'Download',
        'actions.clearHistory': 'Clear history',
        'actions.remove': 'Remove',
        'actions.forgetKey': 'Forget key',
        'actions.save': 'Save',
        'actions.expand': 'Click to expand',
        'actions.close': 'Close',
        'actions.prev': 'Previous image',
        'actions.next': 'Next image',
        'actions.useAsInput': 'Use as input',
        'actions.useAsInputHint': 'Load this result into the source image input',
        'actions.copyPrompt': 'Copy prompt',
        'actions.loading': 'Loading…',
        'status.credits': 'Credits',
        'status.empty': 'Results appear here.',
        'status.unsigned': 'Add a kie.ai API key to start.',
        'status.working': 'Generating…',
        'status.gallery': 'Gallery',
        'status.promptCopied': 'Prompt copied.',
        'status.usedAsInput': 'Sent to the image input.',
      },
    }

    const MODES = [
      { mode: 'text2image', key: 'text2image', action: 'actions.generate', fallbackAction: 'Generate' },
      { mode: 'image2image', key: 'image2image', action: 'actions.edit', fallbackAction: 'Edit image' },
    ]

    /** One Host call; kie.ai's own message and the failed stage survive. */
    async function call(method, args) {
      const response = await fetch(`${ROUTE}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args ?? {}),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`The ${method} call returned a response that was not JSON.`)
      }
      if (!payload?.ok) {
        const failure = new Error(payload?.error ?? `The ${method} call failed.`)
        failure.stage = payload?.stage
        failure.retryable = payload?.retryable === true
        throw failure
      }
      return payload.value
    }

    /* ----------------------------------------------------------------- store */

    const store = {
      mode: 'text2image',
      modelKey: '',
      prompt: '',
      aspectRatio: '1:1',
      size: '1K',
      format: 'png',
      background: '',
      quality: '',
      references: [],
      status: null,
      credits: null,
      history: [],
      running: [],
      error: '',
      stage: '',
      notice: '',
      busy: false,
      activeJob: '',
      keyDraft: '',
      hydrated: false,
      listeners: new Set(),
    }

    function write(patch) {
      Object.assign(store, patch)
      for (const listener of store.listeners) listener()
    }

    function useStore() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1)
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      }, [])
      return [store, write]
    }

    /* ------------------------------------------------------------------- CSS */

    const CSS = `
.gpt-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px}
.gpt-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.gpt-title{font-size:15px;font-weight:600;margin:0}
.gpt-spacer{flex:1}
.gpt-credits{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:3px 10px;font-size:12px}
.gpt-tabs{display:flex;gap:4px;padding:12px 18px 0;flex-wrap:wrap}
.gpt-tab{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;padding:6px 12px;border-radius:6px;cursor:pointer}
.gpt-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.gpt-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600}
.gpt-body{flex:1;min-height:0;overflow:auto;padding:16px 18px}
.gpt-field{display:flex;flex-direction:column;gap:5px;margin-bottom:14px}
.gpt-label{font-weight:600;color:var(--dsw-alias-label-secondary)}
.gpt-hint{color:var(--dsw-alias-label-secondary);font-size:12px}
.gpt-input,.gpt-select,.gpt-textarea{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:7px 9px;width:100%;box-sizing:border-box}
.gpt-textarea{min-height:96px;resize:vertical;font-family:inherit}
.gpt-input:focus-visible,.gpt-select:focus-visible,.gpt-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:var(--dsw-alias-brand-primary)}
.gpt-row{display:flex;gap:12px;flex-wrap:wrap}
.gpt-row>.gpt-field{flex:1;min-width:132px}
.gpt-btn{appearance:none;font:inherit;font-weight:600;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:8px 15px;cursor:pointer}
.gpt-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.gpt-btn:disabled{opacity:.55;cursor:not-allowed}
.gpt-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.gpt-btn-primary:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-brand-primary)}
.gpt-btn-sm{padding:4px 10px;font-weight:500;font-size:12px}
.gpt-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}
.gpt-note{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:10px 12px;margin-bottom:14px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.gpt-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.gpt-ok{border-color:var(--dsw-alias-state-success-primary)}
.gpt-drop{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:14px;text-align:center;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-bg-layer-1)}
.gpt-drop:hover{border-color:var(--dsw-alias-brand-primary)}
.gpt-thumbs{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
.gpt-thumb{position:relative;width:104px}
.gpt-thumb img{width:104px;height:104px;object-fit:cover;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);display:block}
.gpt-thumb-name{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px;word-break:break-all}
.gpt-x{position:absolute;top:4px;right:4px;width:20px;height:20px;border-radius:50%;border:none;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);cursor:pointer;line-height:1;font-size:13px;padding:0}
.gpt-link{color:var(--dsw-alias-brand-primary);text-decoration:none;font-weight:600}
.gpt-link:hover{text-decoration:underline}
.gpt-empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:26px 0}
.gpt-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:gpt-rot .7s linear infinite;vertical-align:-2px}
@keyframes gpt-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.gpt-spin{animation-duration:2s}}
.gpt-check{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary)}
/* Gallery: one card per history entry; the cover image opens the lightbox. */
.gpt-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px}
.gpt-gal-card{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column}
.gpt-gal-card.is-selected{border-color:var(--dsw-alias-brand-primary)}
.gpt-gal-cover{position:relative;line-height:0}
.gpt-gal-cover img{width:100%;aspect-ratio:1/1;object-fit:contain;background:var(--dsw-alias-bg-layer-2);display:block}
.gpt-gal-more{position:absolute;top:6px;right:6px;font-size:10px;font-weight:600;padding:2px 6px;border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
.gpt-gal-place{width:100%;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2)}
.gpt-gal-foot{padding:8px 10px;display:flex;flex-direction:column;gap:6px;min-width:0}
.gpt-gal-prompt{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);cursor:pointer}
.gpt-gal-prompt.is-open{white-space:normal;word-break:break-word}
.gpt-gal-meta{color:var(--dsw-alias-label-secondary);font-size:12px}
.gpt-gal-error{color:var(--dsw-alias-state-error-primary);word-break:break-word}
/* Hovering the card or selecting it surfaces the action bar over the image. */
.gpt-gal-actions{position:absolute;left:0;right:0;bottom:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 8px;background:linear-gradient(transparent,rgba(0,0,0,.72));opacity:0;transition:opacity .13s;pointer-events:none}
.gpt-gal-card:hover .gpt-gal-actions,.gpt-gal-card.is-selected .gpt-gal-actions{opacity:1;pointer-events:auto}
.gpt-gal-actions .gpt-btn{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.35);color:#fff}
.gpt-gal-actions .gpt-btn:hover:not(:disabled){border-color:#fff;color:#fff}
.gpt-gal-actions .gpt-link{color:#fff}
.gpt-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);display:inline-block}
.gpt-layer-tag{font-size:11px;font-weight:600;color:var(--dsw-alias-brand-primary)}
.gpt-zoomable{cursor:zoom-in;border:none;padding:0;background:none;display:block;width:100%}
.gpt-thumb .gpt-zoomable{width:104px;height:104px}
.gpt-lightbox{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:28px;cursor:zoom-out}
.gpt-lightbox img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.gpt-lightbox-bar{position:absolute;top:14px;right:16px;display:flex;gap:8px;align-items:center}
.gpt-lightbox-nav{position:absolute;top:50%;transform:translateY(-50%);font-size:26px;line-height:1;padding:4px 13px;background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.4);color:#fff}
.gpt-lightbox-nav:hover:not(:disabled){border-color:#fff;color:#fff}
.gpt-lightbox-prev{left:16px}
.gpt-lightbox-next{right:16px}
.gpt-lightbox-name{color:#fff;font-size:12px;opacity:.8;max-width:52vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gpt-btn{font:inherit;font-size:12px;padding:3px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.gpt-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.gpt-btn:disabled{opacity:.55;cursor:default}
.gpt-busy{color:var(--dsw-alias-label-secondary);font-size:11px}
`

    /* --------------------------------------------------------------- helpers */

    function useTranslator(ctx) {
      return React.useMemo(() => {
        let bind = null
        try {
          bind = ctx.locale?.bind?.(LOCALE_NS) ?? null
        } catch {
          bind = null
        }
        return (key, fallback) => {
          if (bind === null) return fallback
          try {
            const value = bind(key)
            // ClientLocale resolves an unregistered key to the key itself.
            return typeof value === 'string' && value !== '' && value !== key ? value : fallback
          } catch {
            return fallback
          }
        }
      }, [ctx])
    }

    function readFileAsReference(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
        reader.onload = () =>
          resolve({
            name: file.name,
            mediaType: file.type || 'image/png',
            data: String(reader.result ?? ''),
          })
        reader.readAsDataURL(file)
      })
    }

    /**
     * Image source for a result: durable attachment first, else its URL.
     *
     * The `/stored` read is verified against the reference the store wrote, so
     * the full reference has to travel with the request — an id alone is
     * rejected as corrupt. Images saved by older builds have no reference and
     * fall back to the (20-minute) kie.ai link instead of a broken thumbnail.
     */
    function imageSrc(image) {
      if (image?.saved === true && image?.ref?.attachmentId) {
        const query = new URLSearchParams({ id: image.ref.attachmentId })
        for (const key of ['mediaType', 'width', 'height', 'bytes', 'name']) {
          const value = image.ref[key]
          if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
        }
        return `${ROUTE}/stored?${query.toString()}`
      }
      return typeof image?.url === 'string' ? image.url : ''
    }

    /** Host-proxied download, which mints a fresh 20-minute link for us. */
    function downloadHref(image) {
      const url = encodeURIComponent(image?.url ?? '')
      const name = encodeURIComponent(image?.name ?? 'gpt-image')
      return `${ROUTE}/download?url=${url}&name=${name}`
    }

    /**
     * Bytes for a result the panel wants to reuse as an input.
     *
     * Prefers the durable attachment (works after the kie.ai link expires);
     * falls back to the Host proxy for images that were never stored.
     */
    async function imageDataUrl(image) {
      const source = imageSrc(image)
      if (source === '') throw new Error('This image has no readable source.')
      const response = await fetch(source)
      if (!response.ok) {
        // A saved image whose reference no longer matches falls back to the
        // live link rather than failing outright.
        if (image?.url) {
          const retry = await fetch(`${ROUTE}/imageBytes?url=${encodeURIComponent(image.url)}`)
          if (!retry.ok) throw new Error(`Could not read this image (HTTP ${retry.status}).`)
          return blobToDataUrl(await retry.blob())
        }
        throw new Error(`Could not read this image (HTTP ${response.status}).`)
      }
      return blobToDataUrl(await response.blob())
    }

    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('Could not read the image bytes.'))
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.readAsDataURL(blob)
      })
    }

    /** Copy text to the clipboard, falling back for non-secure contexts. */
    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return
        }
      } catch {
        /* fall through to the legacy path */
      }
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      try {
        const ok = document.execCommand('copy')
        if (!ok) throw new Error('The clipboard refused the copy.')
      } finally {
        document.body.removeChild(area)
      }
    }

    /* -------------------------------------------------------------- fragments */

    /** Left-bar icon; `size` and `active` come from the sidebar owner. */
    function PanelIcon(props) {
      const size = props?.size ?? 16
      const active = props?.active === true
      const stroke = active ? 1.7 : 1.35
      const opacity = active ? 1 : 0.82
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M2.4 5.2 L8 2.2 L13.6 5.2 L8 8.2 Z',
          fill: 'currentColor',
          opacity,
        }),
        h('path', {
          d: 'M2.4 7.9 L8 10.9 L13.6 7.9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: stroke,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity,
        }),
        h('path', {
          d: 'M2.4 10.6 L8 13.6 L13.6 10.6',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: stroke,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: opacity * 0.75,
        }),
      )
    }

    /** Image picker used by image-to-image (up to sixteen sources). */
    function ReferencePicker({ t, references, setReferences, max, disabled }) {
      const inputRef = React.useRef(null)
      const [dragging, setDragging] = React.useState(false)

      const add = async (files) => {
        const images = Array.from(files ?? []).filter((file) => file.type.startsWith('image/'))
        if (images.length === 0) return
        const accepted = []
        for (const file of images) {
          if (file.size > 30 * 1024 * 1024) continue
          try {
            accepted.push(await readFileAsReference(file))
          } catch {
            /* skip an unreadable file rather than failing the whole selection */
          }
        }
        if (accepted.length === 0) return
        setReferences([...references, ...accepted].slice(0, Math.max(1, max)))
      }

      return h(
        'div',
        { className: 'gpt-field' },
        h(
          'span',
          { className: 'gpt-label' },
          max === 1 ? t('fields.sourceImage', 'Source image') : t('fields.referenceImages', 'Reference images'),
        ),
        h(
          'div',
          {
            className: 'gpt-drop',
            role: 'button',
            tabIndex: disabled ? -1 : 0,
            'aria-disabled': disabled ? 'true' : undefined,
            style: dragging ? { borderColor: 'var(--dsw-alias-brand-primary)' } : undefined,
            onClick: () => !disabled && inputRef.current?.click(),
            onKeyDown: (event) => {
              if (disabled) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                inputRef.current?.click()
              }
            },
            onDragOver: (event) => {
              if (disabled) return
              event.preventDefault()
              setDragging(true)
            },
            onDragLeave: () => setDragging(false),
            onDrop: (event) => {
              if (disabled) return
              event.preventDefault()
              setDragging(false)
              void add(event.dataTransfer?.files)
            },
          },
          max === 1
            ? 'Drop or choose one image (PNG, JPEG, WebP · max 30 MiB)'
            : `Drop or choose up to ${max} images (PNG, JPEG, WebP · max 30 MiB each)`,
        ),
        h('input', {
          ref: inputRef,
          type: 'file',
          accept: 'image/png,image/jpeg,image/webp',
          multiple: max > 1,
          hidden: true,
          onChange: (event) => {
            void add(event.target.files)
            event.target.value = ''
          },
        }),
        references.length > 0
          ? h(
              'div',
              { className: 'gpt-thumbs' },
              references.map((reference, index) =>
                h(
                  'div',
                  { className: 'gpt-thumb', key: `${reference.name}-${index}` },
                  h('img', { src: reference.data, alt: reference.name }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'gpt-x',
                      title: t('actions.remove', 'Remove'),
                      'aria-label': `Remove ${reference.name}`,
                      onClick: () => setReferences(references.filter((_, i) => i !== index)),
                    },
                    '\u00d7',
                  ),
                  h('div', { className: 'gpt-thumb-name' }, reference.name),
                ),
              ),
            )
          : null,
      )
    }

    /**
     * Full-size overlay for a result set. Rendered over the whole window so a
     * tall 9:16 image is actually legible; Escape closes, ArrowLeft/ArrowRight
     * walk the images of one entry, and a click on the backdrop closes.
     */
    function Lightbox({ t, images, index, onIndex, onClose }) {
      const list = Array.isArray(images) ? images : []
      const open = list.length > 0
      const at = Math.min(Math.max(index ?? 0, 0), Math.max(list.length - 1, 0))
      const current = open ? list[at] : null
      const close = () => onClose()
      const step = (delta) => {
        if (list.length < 2) return
        onIndex?.((at + delta + list.length) % list.length)
      }

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') close()
          else if (event.key === 'ArrowLeft') step(-1)
          else if (event.key === 'ArrowRight') step(1)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open, list.length, at])
      if (!open) return null
      const src = imageSrc(current)
      const name = current.name || ''
      const nav = (delta, key, label, glyph, extraClass) =>
        list.length > 1
          ? h(
              'button',
              {
                type: 'button',
                className: `gpt-btn gpt-lightbox-nav ${extraClass}`,
                title: label,
                'aria-label': label,
                onClick: (event) => {
                  event?.stopPropagation?.()
                  step(delta)
                },
              },
              glyph,
            )
          : null
      return h(
        'div',
        {
          className: 'gpt-lightbox',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': name || 'Generated image',
          onClick: close,
        },
        src === ''
          ? h('div', { className: 'gpt-lightbox-name' }, 'This image has no readable preview.')
          : h('img', { src, alt: name || 'Generated image', onClick: (event) => event.stopPropagation() }),
        nav(-1, 'prev', t('actions.prev', 'Previous'), '‹', 'gpt-lightbox-prev'),
        nav(1, 'next', t('actions.next', 'Next'), '›', 'gpt-lightbox-next'),
        h(
          'div',
          { className: 'gpt-lightbox-bar', onClick: (event) => event.stopPropagation() },
          h(
            'span',
            { className: 'gpt-lightbox-name' },
            list.length > 1 ? `${name} · ${at + 1} / ${list.length}` : name,
          ),
          current.url
            ? h(
                'a',
                { className: 'gpt-link', href: downloadHref(current), download: current.name },
                t('actions.download', 'Download'),
              )
            : null,
          h(
            'button',
            { type: 'button', className: 'gpt-btn', onClick: close },
            t('actions.close', 'Close'),
          ),
        ),
      )
    }

    /** One history entry as a gallery card: cover image, prompt, metadata, actions. */
    function GalleryCard({ t, entry, selected, onSelect, onUseAsInput, onOpen }) {
      const images = Array.isArray(entry?.images) ? entry.images : []
      const cover = images[0]
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState('')
      const [copied, setCopied] = React.useState(false)
      const [promptOpen, setPromptOpen] = React.useState(false)

      const running = entry.state === 'running'
      const failed = entry.state === 'error'
      const prompt = typeof entry?.prompt === 'string' ? entry.prompt : ''
      const src = cover ? imageSrc(cover) : ''

      const flash = (message) => {
        setNote(message)
        window.setTimeout(() => setNote(''), 2600)
      }

      const use = async () => {
        if (!cover) return
        setBusy('use')
        try {
          const dataUrl = await imageDataUrl(cover)
          onUseAsInput?.({
            name: cover.name || `result-${entry.id}.png`,
            data: dataUrl,
            mediaType: cover.mediaType || 'image/png',
          })
          flash(t('status.usedAsInput', 'Sent to the image input.'))
        } catch (error) {
          flash(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy('')
        }
      }

      const copy = async () => {
        if (prompt === '') return
        setBusy('copy')
        try {
          await copyText(prompt)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 2600)
        } catch (error) {
          flash(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy('')
        }
      }

      const meta = [
        entry.label || entry.model,
        entry.mode,
        entry.aspectRatio,
        entry.size,
        entry.format,
        running
          ? entry.remoteState || 'running'
          : failed
            ? `failed at ${entry.stage ?? 'unknown'}`
            : `${images.length} image(s)`,
        entry.creditsConsumed ? `${entry.creditsConsumed} credits` : '',
      ]
        .filter(Boolean)
        .join(' · ')

      return h(
        'div',
        {
          className: `gpt-gal-card${selected ? ' is-selected' : ''}`,
          key: entry.id,
          onClick: () => onSelect?.(entry.id),
        },
        h(
          'div',
          { className: 'gpt-gal-cover' },
          src === ''
            ? h(
                'div',
                { className: 'gpt-gal-place' },
                h('span', { className: running ? 'gpt-spin' : 'gpt-dot' }),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'gpt-zoomable',
                  title: t('actions.expand', 'Click to expand'),
                  'aria-label': `Expand ${cover.name || 'result'}`,
                  onClick: (event) => {
                    event?.stopPropagation?.()
                    onOpen?.(entry.id, 0)
                  },
                },
                h('img', { src, alt: prompt || entry.label, loading: 'lazy' }),
              ),
          images.length > 1
            ? h('span', { className: 'gpt-gal-more' }, `+${images.length - 1}`)
            : null,
          src !== ''
            ? h(
                'div',
                { className: 'gpt-gal-actions', onClick: (event) => event.stopPropagation() },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'gpt-btn',
                    disabled: busy === 'use',
                    title: t('actions.useAsInputHint', 'Load this result into the source image input'),
                    onClick: () => void use(),
                  },
                  busy === 'use' ? t('actions.loading', 'Loading…') : t('actions.useAsInput', 'Use as input'),
                ),
                prompt !== ''
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'gpt-btn',
                        disabled: busy === 'copy',
                        title: prompt,
                        onClick: () => void copy(),
                      },
                      copied
                        ? t('status.promptCopied', 'Prompt copied.')
                        : busy === 'copy'
                          ? t('actions.loading', 'Loading…')
                          : t('actions.copyPrompt', 'Copy prompt'),
                    )
                  : null,
                cover.url
                  ? h(
                      'a',
                      { className: 'gpt-link', href: downloadHref(cover), download: cover.name },
                      t('actions.download', 'Download'),
                    )
                  : null,
                cover.disk?.saved
                  ? h('span', { className: 'gpt-hint', style: { color: '#ddd' }, title: cover.disk.path }, 'On disk')
                  : null,
              )
            : null,
        ),
        h(
          'div',
          { className: 'gpt-gal-foot' },
          prompt !== ''
            ? h(
                'div',
                {
                  className: `gpt-gal-prompt${promptOpen ? ' is-open' : ''}`,
                  title: prompt,
                  onClick: (event) => {
                    event?.stopPropagation?.()
                    setPromptOpen((open) => !open)
                  },
                },
                prompt,
              )
            : null,
          h('div', { className: 'gpt-gal-meta' }, meta),
          failed && entry.error ? h('div', { className: 'gpt-gal-error' }, entry.error) : null,
          note !== '' ? h('div', { className: 'gpt-hint' }, note) : null,
        ),
      )
    }

    /** The gallery: every history entry as a card, newest first, plus its lightbox. */
    function Gallery({ t, history, onUseAsInput }) {
      const [selectedId, setSelectedId] = React.useState('')
      const [zoom, setZoom] = React.useState(null)

      if (history.length === 0) return h('div', { className: 'gpt-empty' }, t('status.empty', 'Results appear here.'))

      const zoomEntry = zoom ? history.find((entry) => entry.id === zoom.id) : null
      const zoomImages = Array.isArray(zoomEntry?.images) ? zoomEntry.images : []

      return h(
        'div',
        { style: { marginTop: 20 } },
        h(
          'div',
          { className: 'gpt-label', style: { marginBottom: 8 } },
          `${t('status.gallery', 'Gallery')} (${history.length})`,
        ),
        h(
          'div',
          { className: 'gpt-gallery' },
          history.map((entry) =>
            h(GalleryCard, {
              key: entry.id,
              t,
              entry,
              selected: selectedId === entry.id,
              onSelect: setSelectedId,
              onUseAsInput,
              onOpen: (id, index) => setZoom({ id, index }),
            }),
          ),
        ),
        h(Lightbox, {
          t,
          images: zoomImages,
          index: zoom?.index ?? 0,
          onIndex: (index) => setZoom((state) => (state ? { ...state, index } : state)),
          onClose: () => setZoom(null),
        }),
      )
    }

    /* ----------------------------------------------------------------- panel */

    function Panel(props) {
      const ctx = props?.ctx
      const t = useTranslator(ctx)
      const [shared, set] = useStore()
      const { mode, modelKey, prompt, aspectRatio, size, format, background, quality, references, status, credits, history, running, error, stage, notice, busy, activeJob } = shared

      const models = status?.models ?? []
      const currentMode = MODES.some((entry) => entry.mode === mode) ? mode : 'text2image'
      const tabModels = models.filter((entry) => entry.mode === currentMode)
      const model =
        tabModels.find((entry) => entry.key === modelKey || entry.id === modelKey) ?? tabModels[0]
      const modeAction = MODES.find((entry) => entry.mode === currentMode)

      const allowedSizes = model?.sizes ?? ['1K']
      const allowedRatios = model?.aspectRatios ?? ['1:1']
      const allowedFormats = model?.formats ?? ['png']
      const allowedBackgrounds = model?.backgrounds ?? []
      // Flare and Sunburst expose a quality dial; Economy reports an empty list.
      const allowedQualities = model?.qualities ?? []
      // The Host falls back to `medium` for a missing quality, so the panel uses
      // the same value instead of the first entry of the list — otherwise a trip
      // through Economy (which has no dial, and clears the value) would come back
      // on Flare as `low` and silently change the render the user gets.
      const defaultQuality = allowedQualities.includes('medium') ? 'medium' : allowedQualities[0] ?? ''
      const maxRefs = model?.maxReferences ?? 0
      const promptRequired = model?.promptRequired !== false
      // The Host publishes each model's bounds; Flare/Sunburst allow 32000
      // characters where Economy stops at 20000, so the counter reads them.
      const promptMin = model?.promptLimits?.min ?? 1
      const promptMax = model?.promptLimits?.max ?? 32000
      const effectiveBackground = allowedBackgrounds.includes(background)
        ? background
        : allowedBackgrounds[0] ?? ''

      // Re-sync option values when a mode's accepted set differs.
      const effectiveSize = allowedSizes.includes(size) ? size : allowedSizes[0]
      const effectiveRatio = allowedRatios.includes(aspectRatio) ? aspectRatio : allowedRatios[0]
      const effectiveFormat = allowedFormats.includes(format) ? format : allowedFormats[0]
      const effectiveQuality = allowedQualities.includes(quality) ? quality : defaultQuality

      React.useEffect(() => {
        if (!allowedSizes.includes(size)) set({ size: allowedSizes[0] })
        if (!allowedRatios.includes(aspectRatio)) set({ aspectRatio: allowedRatios[0] })
        // A transparent background needs PNG or webp, so switching format must
        // move the background off `transparent` rather than fail at submit.
        if (allowedBackgrounds.length > 0 && !allowedBackgrounds.includes(background)) {
          set({ background: allowedBackgrounds[0] })
        }
        if (allowedQualities.length > 0 && !allowedQualities.includes(quality)) {
          set({ quality: defaultQuality })
        }
      }, [currentMode, modelKey])

      /** Pick a model inside the current tab; keep the size/ratio/format valid. */
      const chooseModel = React.useCallback(
        (key) => {
          const next = tabModels.find((entry) => entry.key === key)
          set({ modelKey: key })
          if (next !== undefined) {
            if (!next.sizes.includes(size)) set({ size: next.sizes[0] })
            if (!next.aspectRatios.includes(aspectRatio)) {
              set({ aspectRatio: next.aspectRatios[0] })
            }
            // A quality the new model cannot accept is replaced by that model's
            // default quality (the same value `medium`-preferring Host would apply).
            const qualities = next.qualities ?? []
            if (qualities.length === 0) {
              if (quality !== '') set({ quality: '' })
            } else if (!qualities.includes(quality)) {
              set({ quality: qualities.includes('medium') ? 'medium' : qualities[0] })
            }
            if (next.formats.length > 0 && !next.formats.includes(format)) {
              set({ format: next.formats[0] })
            }
            const allowed = next.backgrounds ?? []
            if (allowed.length === 0) {
              if (background !== '') set({ background: '' })
            } else if (!allowed.includes(background)) {
              set({ background: allowed[0] })
            }
          }
        },
        [tabModels, size, aspectRatio, format, background, quality],
      )

      /**
       * Load a finished result back into the source-image input.
       *
       * "Use as input" is meant to feed an edit, so it also switches to the
       * image-editing mode when the current mode takes no source image —
       * otherwise the new reference would be dropped by the size cap.
       */
      const useAsInput = React.useCallback((reference) => {
        const editingMax = models.find((entry) => entry.mode === 'image2image')?.maxReferences ?? 0
        const currentMax = models.find((entry) => entry.mode === currentMode)?.maxReferences ?? 0
        const nextMode = currentMax > 0 ? currentMode : editingMax > 0 ? 'image2image' : currentMode
        set({
          mode: nextMode,
          // A key from the old tab means nothing in the new one, so clear it and
          // let the model resolve to that tab's default.
          modelKey: nextMode === currentMode ? modelKey : '',
          references: [{ name: reference.name, data: reference.data }],
        })
      }, [currentMode, modelKey, models])

      const sync = React.useCallback(async () => {
        try {
          const value = await call('listHistory')
          const entries = Array.isArray(value?.entries) ? value.entries : []
          const live = Array.isArray(value?.running) ? value.running : []
          set({ history: entries, running: live, busy: live.length > 0, activeJob: live[0] ?? '' })
        } catch {
          /* keep the previous list; a transient read failure is not fatal */
        }
      }, [])

      const refreshCredits = React.useCallback(async () => {
        try {
          const value = await call('credits')
          set({ credits: typeof value?.credits === 'number' ? value.credits : null })
        } catch {
          /* credits are informational; keep the last value */
        }
      }, [])

      // Hydrate once per page load, then read the durable history.
      React.useEffect(() => {
        let live = true
        ;(async () => {
          try {
            const value = await call('status')
            if (!live) return
            set({ status: value, hydrated: true })
            if (value?.configured === true) void refreshCredits()
          } catch (failure) {
            if (live) set({ error: failure.message })
          }
        })()
        void sync()
        return () => {
          live = false
        }
      }, [])

      // Poll while any task runs, and refresh credits when one settles.
      React.useEffect(() => {
        if (!busy) return undefined
        const timer = setInterval(() => void sync(), 3000)
        return () => clearInterval(timer)
      }, [busy, sync])

      const wasBusy = React.useRef(false)
      React.useEffect(() => {
        if (wasBusy.current && !busy) void refreshCredits()
        wasBusy.current = busy
      }, [busy, refreshCredits])

      const saveKey = async () => {
        set({ error: '', stage: '' })
        try {
          await call('setApiKey', { apiKey: shared.keyDraft })
          set({ keyDraft: '', notice: 'API key stored.' })
          const value = await call('status')
          set({ status: value })
          if (value?.configured === true) void refreshCredits()
        } catch (failure) {
          set({ error: failure.message })
        }
      }

      const clearKey = async () => {
        set({ error: '', stage: '' })
        try {
          await call('clearApiKey')
          set({ notice: 'API key removed.', credits: null })
          set({ status: await call('status') })
        } catch (failure) {
          set({ error: failure.message })
        }
      }

      const run = async () => {
        set({ busy: true, error: '', stage: '', notice: t('status.working', 'Generating…') })
        try {
          const started = await call('startJob', {
            mode: currentMode,
            model: model?.key ?? '',
            prompt,
            aspectRatio: effectiveRatio,
            size: effectiveSize,
            format: effectiveFormat,
            background: effectiveBackground,
            quality: effectiveQuality,
            references: maxRefs === 0 ? [] : references.map((reference) => reference.data),
          })
          set({ activeJob: started?.jobId ?? '' })
          await sync()
        } catch (failure) {
          set({ busy: false, error: failure.message, stage: failure.stage ?? '', notice: '' })
        }
      }

      const cancel = async () => {
        try {
          await call('cancelJob', { jobId: activeJob })
        } catch {
          /* the task may have settled already */
        }
        set({ busy: false, activeJob: '', notice: 'Cancelled.', error: '', stage: '' })
        await sync()
      }

      const clearAll = async () => {
        try {
          await call('clearHistory')
        } catch {
          /* the visible list is cleared either way */
        }
        set({ history: [], notice: 'History cleared.' })
      }

      const canRun =
        !busy &&
        status?.configured === true &&
        (promptRequired ? prompt.trim() !== '' : true) &&
        (currentMode === 'text2image' || references.length >= (model?.minReferences ?? 1))

      const placeholder = 'A small house by a lake, watercolor illustration.'

      return h(
        'div',
        { className: 'gpt-root' },
        h(
          'div',
          { className: 'gpt-head' },
          h('h1', { className: 'gpt-title' }, t('panel.title', 'GPT Image')),
          h('span', { className: 'gpt-spacer' }),
          status?.configured
            ? h(
                'span',
                { className: 'gpt-credits', title: 'Remaining kie.ai credits' },
                `${t('status.credits', 'Credits')}: ${credits === null ? '—' : credits}`,
              )
            : null,
        ),
        h(
          'div',
          { className: 'gpt-tabs', role: 'tablist' },
          MODES.map((entry) =>
            h(
              'button',
              {
                key: entry.mode,
                type: 'button',
                role: 'tab',
                className: 'gpt-tab',
                'aria-selected': currentMode === entry.mode ? 'true' : 'false',
                onClick: () => set({ mode: entry.mode, modelKey: '' }),
              },
              t(`tabs.${entry.key}`, entry.mode),
            ),
          ),
        ),
        h(
          'div',
          { className: 'gpt-body' },
          status !== null && status.configured !== true
            ? h(
                'div',
                { className: 'gpt-note' },
                h('div', null, `No kie.ai API key found in ${status.apiKeyEnv}.`),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, marginTop: 8 } },
                  h('input', {
                    className: 'gpt-input',
                    type: 'password',
                    placeholder: 'Paste your kie.ai API key',
                    value: shared.keyDraft,
                    onChange: (event) => set({ keyDraft: event.target.value }),
                    onKeyDown: (event) => event.key === 'Enter' && shared.keyDraft.trim() !== '' && void saveKey(),
                  }),
                  h(
                    'button',
                    { type: 'button', className: 'gpt-btn gpt-btn-primary', disabled: shared.keyDraft.trim() === '', onClick: () => void saveKey() },
                    t('actions.save', 'Save'),
                  ),
                ),
                h('div', { className: 'gpt-hint', style: { marginTop: 6 } }, 'Stored on the Host in the credential service, never in this page.'),
              )
            : null,

          error !== ''
            ? h(
                'div',
                { className: 'gpt-note gpt-error', role: 'alert' },
                stage !== ''
                  ? h(
                      'div',
                      { className: 'gpt-hint', style: { marginBottom: 4 } },
                      stage === 'upload'
                        ? 'Failed while uploading the reference image.'
                        : stage === 'create'
                          ? 'kie.ai rejected the task request.'
                          : stage === 'poll'
                            ? 'Failed while waiting for kie.ai.'
                            : stage === 'generate'
                              ? 'kie.ai reported the generation failed.'
                              : stage === 'download'
                                ? 'Generated, but the file could not be downloaded.'
                                : `Failed at: ${stage}.`,
                    )
                  : null,
                h('div', null, error),
              )
            : null,
          notice !== '' ? h('div', { className: 'gpt-note gpt-ok' }, notice) : null,

          h(
            'div',
            { className: 'gpt-field' },
            h(
              'label',
              { className: 'gpt-label', htmlFor: 'gpt-prompt' },
              t('fields.prompt', 'Prompt'),
              promptRequired ? null : h('span', { className: 'gpt-hint' }, '  (optional)'),
            ),
            h('textarea', {
              id: 'gpt-prompt',
              className: 'gpt-textarea',
              value: prompt,
              placeholder,
              onChange: (event) => set({ prompt: event.target.value }),
            }),
            h(
              'span',
              { className: 'gpt-hint' },
              `${prompt.trim().length} / ${promptMax} characters · ${promptMin} minimum`,
            ),
          ),

          maxRefs > 0
            ? h(ReferencePicker, {
                t,
                references,
                setReferences: (value) => set({ references: value }),
                max: maxRefs,
                disabled: busy,
              })
            : null,

          h(
            'div',
            { className: 'gpt-row' },
            tabModels.length > 1
              ? h(
                  'div',
                  { className: 'gpt-field' },
                  h('label', { className: 'gpt-label', htmlFor: 'gpt-model' }, t('fields.model', 'Model')),
                  h(
                    'select',
                    {
                      id: 'gpt-model',
                      className: 'gpt-select',
                      value: model?.key ?? '',
                      disabled: busy,
                      onChange: (event) => chooseModel(event.target.value),
                    },
                    tabModels.map((entry) =>
                      h('option', { key: entry.key, value: entry.key }, entry.label ?? entry.id),
                    ),
                  ),
                )
              : null,
            allowedRatios.length > 0
              ? h(
                  'div',
                  { className: 'gpt-field' },
                  h('label', { className: 'gpt-label', htmlFor: 'gpt-ratio' }, t('fields.aspectRatio', 'Aspect ratio')),
                  h(
                    'select',
                    {
                      id: 'gpt-ratio',
                      className: 'gpt-select',
                      value: effectiveRatio,
                      onChange: (event) => set({ aspectRatio: event.target.value }),
                    },
                    allowedRatios.map((value) => h('option', { key: value, value }, value)),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'gpt-field' },
              h('label', { className: 'gpt-label', htmlFor: 'gpt-size' }, t('fields.size', 'Resolution')),
              h(
                'select',
                {
                  id: 'gpt-size',
                  className: 'gpt-select',
                  value: effectiveSize,
                  onChange: (event) => set({ size: event.target.value }),
                },
                allowedSizes.map((value) => h('option', { key: value, value }, value === 'auto' ? 'Auto (match input)' : value)),
              ),
            ),
            h(
              'div',
              { className: 'gpt-field' },
              h('label', { className: 'gpt-label', htmlFor: 'gpt-format' }, t('fields.format', 'Format')),
              h(
                'select',
                {
                  id: 'gpt-format',
                  className: 'gpt-select',
                  value: effectiveFormat,
                  onChange: (event) => set({ format: event.target.value }),
                },
                allowedFormats.map((value) => h('option', { key: value, value }, value.toUpperCase())),
              ),
            ),
            allowedQualities.length > 0
              ? h(
                  'div',
                  { className: 'gpt-field' },
                  h('label', { className: 'gpt-label', htmlFor: 'gpt-quality' }, t('fields.quality', 'Quality')),
                  h(
                    'select',
                    {
                      id: 'gpt-quality',
                      className: 'gpt-select',
                      value: effectiveQuality,
                      disabled: busy,
                      onChange: (event) => set({ quality: event.target.value }),
                    },
                    allowedQualities.map((value) =>
                      h('option', { key: value, value }, value.charAt(0).toUpperCase() + value.slice(1)),
                    ),
                  ),
                )
              : null,
            allowedBackgrounds.length > 0
              ? h(
                  'div',
                  { className: 'gpt-field' },
                  h('label', { className: 'gpt-label', htmlFor: 'gpt-background' }, t('fields.background', 'Background')),
                  h(
                    'select',
                    {
                      id: 'gpt-background',
                      className: 'gpt-select',
                      value: effectiveBackground,
                      disabled: busy,
                      onChange: (event) => set({ background: event.target.value }),
                    },
                    allowedBackgrounds.map((value) =>
                      h(
                        'option',
                        { key: value, value, disabled: value === 'transparent' && effectiveFormat !== 'png' },
                        value.charAt(0).toUpperCase() + value.slice(1),
                      ),
                    ),
                  ),
                )
              : null,
          ),

          h(
            'div',
            { className: 'gpt-actions', style: { marginTop: 14 } },
            h(
              'button',
              { type: 'button', className: 'gpt-btn gpt-btn-primary', disabled: !canRun, onClick: () => void run() },
              busy
                ? h('span', null, h('span', { className: 'gpt-spin' }), ' ', t('status.working', 'Generating…'))
                : t(modeAction?.action ?? 'actions.generate', modeAction?.fallbackAction ?? 'Generate'),
            ),
            busy
              ? h('button', { type: 'button', className: 'gpt-btn', onClick: () => void cancel() }, t('actions.cancel', 'Cancel'))
              : null,
            busy ? h('span', { className: 'gpt-hint' }, 'Keeps running if you switch panels.') : null,
            !busy && history.length > 0
              ? h('button', { type: 'button', className: 'gpt-btn', onClick: () => void clearAll() }, t('actions.clearHistory', 'Clear history'))
              : null,
            status?.configured
              ? h('button', { type: 'button', className: 'gpt-btn gpt-btn-sm', onClick: () => void refreshCredits() }, 'Refresh credits')
              : null,
            status?.configured
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'gpt-btn gpt-btn-sm',
                    title: `Remove the stored key from ${status.apiKeyEnv}`,
                    onClick: () => void clearKey(),
                  },
                  t('actions.forgetKey', 'Forget key'),
                )
              : null,
          ),

          h(Gallery, { t, history, onUseAsInput: useAsInput }),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (typeof ctx.locale?.register === 'function') {
          ctx.effect(() => ctx.locale.register(LOCALE_NS, LOCALE), 'gpt-image-playground:locale')
        }

        ctx.effect(() => {
          if (typeof document !== 'undefined') {
            const tag = document.createElement('style')
            tag.setAttribute('data-gpt-image-playground', '')
            tag.textContent = CSS
            document.head.appendChild(tag)
            return () => tag.remove()
          }
          return () => {}
        }, 'gpt-image-playground/styles')

        // The left-bar entry.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => {
                // Guarded: an unregistered key resolves to the key itself, and
                // the sidebar must never render "panel.title".
                try {
                  const value = ctx.locale?.bind?.(LOCALE_NS)?.('panel.title')
                  return typeof value === 'string' && value !== '' && value !== 'panel.title'
                    ? value
                    : 'GPT Image'
                } catch {
                  return 'GPT Image'
                }
              },
            },
            PanelIcon,
          ),
        )

        // The panel body the sidebar opens for the same id. The slot passes only
        // hook props, so the plugin context comes from this closure.
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Panel, { ctx })))
      },
    }
  },
})
