window.__ModuleLoader__.load({
  id: 'dsh-ai-retitle',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'ai-retitle'
    const COMMAND_LINE = '/retitle'

    const EN = {
      action: 'Regenerate title from the conversation',
      busy: 'Generating a title…',
      done: 'Title updated',
      failed: 'Could not rename this conversation',
      unavailable: 'This build cannot reach the Host command service',
    }

    const ZH = {
      action: '根据当前对话重新生成标题',
      busy: '正在生成标题…',
      done: '标题已更新',
      failed: '重命名失败',
      unavailable: '当前构建无法调用 Host 的命令服务',
    }

    const CSS = [
      '.dsh-ai-retitle{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .12s ease,color .12s ease}',
      '.dsh-ai-retitle:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-ai-retitle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-ai-retitle:disabled{opacity:.65}',
      '.dsh-ai-retitle[data-phase="busy"]{cursor:progress}',
      '.dsh-ai-retitle[data-phase="done"]{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-ai-retitle[data-phase="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-ai-retitle-spin{animation:dsh-ai-retitle-spin .9s linear infinite;transform-origin:center}',
      '@keyframes dsh-ai-retitle-spin{to{transform:rotate(360deg)}}',
    ].join('\n')

    function sparkles() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M12 3.4 L13.9 9.1 L19.6 11 L13.9 12.9 L12 18.6 L10.1 12.9 L4.4 11 L10.1 9.1 Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M18.3 14.9 L18.9 16.6 L20.6 17.2 L18.9 17.8 L18.3 19.5 L17.7 17.8 L16 17.2 L17.7 16.6 Z',
          fill: 'currentColor',
          opacity: 0.7,
        }))
    }

    function spinner() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        className: 'dsh-ai-retitle-spin',
        'aria-hidden': 'true',
        style: { display: 'block' },
      },
      h('circle', { cx: 12, cy: 12, r: 8, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.25, strokeWidth: 3 }),
      h('path', {
        d: 'M12 4 a8 8 0 0 1 8 8',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 3,
        strokeLinecap: 'round',
      }))
    }

    function check() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M5 12.6 L9.6 17.2 L19 7.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))
    }

    return {
      // `remote.commands` is the traced child service of `remote` that serves the
      // `commands/execute` endpoint; declaring the dotted key is what the Cordis
      // guard asks for. `hostCommands()` still falls back to `ctx.get()`.
      inject: ['slots', 'remote', 'remote.commands', 'locale'],
      apply(ctx) {
        const disposers = []

        try {
          disposers.push(ctx.locale.register(NS, 'en', EN))
          disposers.push(ctx.locale.register(NS, 'zh', ZH))
        } catch (error) {
          // A locale without a dictionary still renders the key names.
          console.warn('[ai-retitle] locale registration failed', error)
        }

        let translate
        try {
          translate = ctx.locale.bind(NS)
        } catch (error) {
          console.warn('[ai-retitle] locale binding failed', error)
          translate = (key) => key
        }

        /**
         * Resolve the Host `commands` Remote namespace.
         *
         * The namespace is a traced child service whose exact key is
         * `remote.commands`, so `ctx.remote.commands` is refused unless that
         * dotted key is declared in `inject`. `ctx.get()` is the supported read
         * for an undeclared service; the other paths keep working if a future
         * build exposes the namespaces as plain nested objects instead.
         */
        function hostCommands() {
          const readers = [
            () => (typeof ctx.get === 'function' ? ctx.get('remote.commands') : undefined),
            () => ctx['remote.commands'],
            () => (ctx.remote ? ctx.remote.commands : undefined),
          ]
          for (const read of readers) {
            try {
              const candidate = read()
              if (candidate && typeof candidate.execute === 'function') return candidate
            } catch (error) {
              // This access path is not allowed here; the next one may be.
            }
          }
          return undefined
        }

        function RetitleButton(props) {
          const sessionId = props && props.sessionId
          const displayTitle = props && props.displayTitle
          const [phase, setPhase] = React.useState('idle')
          const [detail, setDetail] = React.useState('')
          const alive = React.useRef(true)
          const timers = React.useRef([])
          const [, setLocaleRevision] = React.useState(0)

          React.useEffect(() => {
            alive.current = true
            return () => {
              alive.current = false
            }
          }, [])

          React.useEffect(() => () => {
            for (const id of timers.current) clearTimeout(id)
            timers.current = []
          }, [])

          React.useEffect(() => {
            let unsubscribe = () => {}
            try {
              unsubscribe = ctx.locale.subscribe(() => setLocaleRevision((value) => value + 1))
            } catch (error) {
              console.warn('[ai-retitle] locale subscription failed', error)
            }
            return () => {
              try {
                unsubscribe()
              } catch (error) {
                console.warn('[ai-retitle] locale unsubscribe failed', error)
              }
            }
          }, [])

          if (!sessionId || !displayTitle) return null

          const later = (delay, task) => {
            const id = setTimeout(() => {
              if (alive.current) task()
            }, delay)
            timers.current.push(id)
          }

          const start = async () => {
            if (phase === 'busy') return
            for (const id of timers.current) clearTimeout(id)
            timers.current = []
            setPhase('busy')
            setDetail('')
            let controller
            try {
              controller = new AbortController()
            } catch {
              controller = undefined
            }
            const signal = controller ? controller.signal : undefined
            try {
              const commands = hostCommands()
              if (!commands) {
                throw new Error(translate('unavailable'))
              }
              const result = signal
                ? await commands.execute(sessionId, COMMAND_LINE, [], signal)
                : await commands.execute(sessionId, COMMAND_LINE, [])
              if (!result || result.ok !== true) {
                const failure = result && result.error
                throw new Error(failure && failure.message ? failure.message : translate('failed'))
              }
              const outcome = result.value && result.value.result
              if (!outcome || outcome.kind !== 'success') {
                throw new Error(outcome && typeof outcome.text === 'string' && outcome.text.length > 0
                  ? outcome.text
                  : translate('failed'))
              }
              if (!alive.current) return
              setPhase('done')
              setDetail(typeof outcome.text === 'string' ? outcome.text : '')
              later(2400, () => setPhase('idle'))
            } catch (error) {
              if (!alive.current) return
              const message = error && error.message ? error.message : String(error)
              setPhase('error')
              setDetail(message.length > 160 ? `${message.slice(0, 160)}…` : message)
              later(6000, () => setPhase('idle'))
            }
          }

          const label = phase === 'busy'
            ? translate('busy')
            : phase === 'error' && detail.length > 0
              ? `${translate('failed')}: ${detail}`
              : phase === 'done'
                ? translate('done')
                : translate('action')

          const glyph = phase === 'busy' ? spinner() : phase === 'done' ? check() : sparkles()

          return h(React.Fragment, null,
            h('style', { key: 'style' }, CSS),
            h('button', {
              key: 'button',
              type: 'button',
              className: 'dsh-ai-retitle',
              'data-phase': phase,
              title: label,
              'aria-label': label,
              'aria-busy': phase === 'busy' ? 'true' : undefined,
              disabled: phase === 'busy',
              onClick: () => {
                void start()
              },
            }, glyph))
        }

        disposers.push(ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action',
          id: 'ai-retitle',
          order: 150,
        }, RetitleButton)))

        return () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch (error) {
              console.warn('[ai-retitle] disposal failed', error)
            }
          }
        }
      },
    }
  },
})
