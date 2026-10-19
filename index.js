/**
 * Host half of the AI retitle bundle.
 *
 * One operation — regenerate a session title from the conversation so far — is
 * exposed three ways: the `/retitle` command (the sidebar button and the
 * composer both execute it), the `retitle_conversation` tool, and the title
 * pipeline itself, which only ever sees the accepted `session/title` event.
 *
 * The module imports nothing: the shipped services are reached through `ctx`,
 * so the package installs without dependencies and works in any profile that
 * has `commands`, `sessionTitle`, and `llm`.
 *
 * @module dsh-ai-retitle
 */

export const name = 'ai-retitle'

export const inject = ['commands', 'sessionTitle', 'llm', 'tools']

/** Command name without the leading slash; the Client half executes this line. */
const COMMAND_NAME = 'retitle'

/** Model-facing tool name. */
const TOOL_NAME = 'retitle_conversation'

/** Fallback policy; every field may be overridden by the row's `config`. */
const DEFAULTS = {
  timeoutMs: 30000,
  // Reasoning tokens count toward this cap, so a title budget must leave room
  // for the thinking that precedes the one-line answer.
  maxOutputTokens: 512,
  maxRecentMessages: 16,
  maxInputBytes: 12000,
  targetWords: 8,
  targetCjkCharacters: 18,
}

const MAX_TITLE_CHARACTERS = 120
const MAX_MESSAGE_CHARACTERS = 480
const MAX_HINT_CHARACTERS = 200

/* Terminal control sequences and invisible directionals, as the title service does. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
const INVISIBLE_CHARACTERS = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/** A whole line wrapped in one ASCII emphasis marker, such as `**Title**`. */
const EMPHASIS_WRAPPER = /^(\*{1,3})(\S(?:.*\S)?)\1$/u

/** Quotes a model may add around a title. */
const QUOTE_WRAPPER = /^["'`\u201C\u201D\u00AB\u00BB\u300C\u300D\u300E\u300F]+|["'`\u201C\u201D\u00AB\u00BB\u300C\u300D\u300E\u300F]+$/gu

/**
 * Validate the optional row configuration against the defaults.
 * @param {unknown} config - raw row configuration.
 * @returns resolved settings.
 */
function resolveConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const provider = nonEmptyString(source.provider)
  const model = nonEmptyString(source.model)
  return {
    // A half-configured route is ignored rather than failing activation.
    provider: provider !== undefined && model !== undefined ? provider : undefined,
    model: provider !== undefined && model !== undefined ? model : undefined,
    timeoutMs: positiveInteger(source.timeoutMs, DEFAULTS.timeoutMs),
    maxOutputTokens: positiveInteger(source.maxOutputTokens, DEFAULTS.maxOutputTokens),
    maxRecentMessages: positiveInteger(source.maxRecentMessages, DEFAULTS.maxRecentMessages),
    maxInputBytes: positiveInteger(source.maxInputBytes, DEFAULTS.maxInputBytes),
    targetWords: positiveInteger(source.targetWords, DEFAULTS.targetWords),
    targetCjkCharacters: positiveInteger(source.targetCjkCharacters, DEFAULTS.targetCjkCharacters),
  }
}

/**
 * @param {unknown} value - candidate.
 * @returns the trimmed string, or `undefined` when it is not one.
 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * @param {unknown} value - candidate.
 * @param {number} fallback - value used when the candidate is not a positive integer.
 * @returns a positive safe integer.
 */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * Remove control sequences and collapse whitespace into one line.
 * @param {unknown} input - untrusted text.
 * @returns sanitized text.
 */
function cleanText(input) {
  return String(input === undefined || input === null ? '' : input)
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Join the text blocks of one message.
 * @param {unknown} blocks - message content.
 * @returns the concatenated text.
 */
function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Resolve the live session behind a command or tool invocation.
 * @param {object} ctx - plugin context.
 * @param {object} [agent] - agent supplied by the invocation.
 * @returns the session, or `undefined`.
 */
function sessionOf(ctx, agent) {
  if (!agent) return undefined
  if (agent.session) return agent.session
  try {
    // `ctx.get` reads a service that is not a declared dependency of this plugin.
    const store = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    return store && typeof store.get === 'function' ? store.get(agent.id) : undefined
  } catch {
    return undefined
  }
}

/**
 * Pick the model route: an explicit configuration pair, the session's last logged
 * main request, or the deployment default selection.
 * @param {object} ctx - plugin context.
 * @param {object} session - session whose request header anchors the route.
 * @param {object} settings - resolved settings.
 * @returns `{ provider, model }`, or `undefined` when nothing is routable.
 */
function resolveRoute(ctx, session, settings) {
  if (settings.provider !== undefined && settings.model !== undefined) {
    return { provider: settings.provider, model: settings.model }
  }
  try {
    const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
    const config = header && header.config
    if (config && config.provider && config.model) return { provider: config.provider, model: config.model }
  } catch {
    /* fall through to the default selection */
  }
  try {
    const selection = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    const current = selection && typeof selection.currentSelection === 'function' ? selection.currentSelection() : undefined
    if (current && current.provider && current.model) return { provider: current.provider, model: current.model }
  } catch {
    /* no default model service in this profile */
  }
  return undefined
}

/**
 * Combine caller cancellation with the request deadline.
 * @param {AbortSignal|undefined} first - invocation signal.
 * @param {AbortSignal} second - deadline signal.
 * @returns one signal aborted by either input.
 */
function combineSignals(first, second) {
  if (!first) return second
  if (typeof AbortSignal.any === 'function') {
    try {
      return AbortSignal.any([first, second])
    } catch {
      /* fall back to a manual bridge */
    }
  }
  const controller = new AbortController()
  if (first.aborted || second.aborted) {
    controller.abort()
    return controller.signal
  }
  const abort = () => controller.abort()
  first.addEventListener('abort', abort, { once: true })
  second.addEventListener('abort', abort, { once: true })
  return controller.signal
}

/**
 * Build the excerpt that represents the conversation: the earliest human messages
 * that named it, the newest exchanges, and the most recent assistant replies.
 * @param {object} session - session to read.
 * @param {object} settings - resolved settings.
 * @returns `{ entries, truncated }` in chronological order.
 */
function buildExcerpt(session, settings) {
  const users = []
  const assistants = []
  let events = []
  try {
    events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  } catch {
    events = []
  }
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'user/message') {
      const data = event.data
      if (!data || !data.source || data.source.kind !== 'user') continue
      const text = cleanText(textOfBlocks(data.content))
      if (text.length > 0) users.push({ seq: event.seq, role: 'user', text })
    } else if (event.type === 'assistant/message') {
      const message = event.data && event.data.message
      const text = cleanText(textOfBlocks(message && message.content))
      if (text.length > 0) assistants.push({ seq: event.seq, role: 'assistant', text })
    }
  }

  const picked = new Map()
  const recent = Math.max(1, settings.maxRecentMessages)
  for (const item of users.slice(0, 2)) picked.set(item.seq, item)
  for (const item of users.slice(-recent)) picked.set(item.seq, item)
  for (const item of assistants.slice(-3)) picked.set(item.seq, item)
  const ordered = Array.from(picked.values()).sort((left, right) => left.seq - right.seq)

  const compact = (item) => {
    const text = item.text.length > MAX_MESSAGE_CHARACTERS
      ? `${item.text.slice(0, MAX_MESSAGE_CHARACTERS)}\u2026`
      : item.text
    return {
      entry: { seq: item.seq, role: item.role, text },
      cost: Buffer.byteLength(text, 'utf8') + 24,
    }
  }

  const budget = Math.max(1024, settings.maxInputBytes)
  const chosen = []
  let used = 0
  let truncated = false
  const first = ordered[0]
  if (first !== undefined) {
    const prepared = compact(first)
    chosen.push(prepared.entry)
    used += prepared.cost
  }
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const item = ordered[index]
    if (first !== undefined && item.seq === first.seq) continue
    const prepared = compact(item)
    if (used + prepared.cost > budget) {
      truncated = true
      continue
    }
    chosen.push(prepared.entry)
    used += prepared.cost
  }
  chosen.sort((left, right) => left.seq - right.seq)
  return {
    entries: chosen.map((item) => ({ role: item.role, text: item.text })),
    truncated,
  }
}

/**
 * Language-aware system instruction for a title derived from the whole conversation.
 * @param {object} settings - resolved settings.
 * @returns the instruction.
 */
function buildSystemPrompt(settings) {
  return [
    'Create a concise, specific title for an AI coding-assistant session from the supplied conversation excerpt.',
    'Weight the most recent messages most heavily while keeping the title accurate for the whole session.',
    'Return only the title on one line in plain natural language: no quotes, prefix, explanation, Markdown, XML, emoji, or terminal control codes, and no code.',
    'Use the language of the messages.',
    `Aim for about ${settings.targetWords} words in non-CJK languages or ${settings.targetCjkCharacters} CJK characters.`,
    'If the messages give little to name, return a short best-effort title such as Greeting instead of explaining.',
  ].join('\n')
}

/**
 * Frame the excerpt as JSON so conversation text cannot break structural delimiters.
 * @param {{ entries: object[], truncated: boolean }} excerpt - selected messages.
 * @param {string} hint - optional user focus.
 * @returns the user turn.
 */
function buildUserInput(excerpt, hint) {
  const lines = [
    'Generate the session title from this JSON array of messages, oldest first:',
    JSON.stringify(excerpt.entries),
  ]
  if (hint.length > 0) lines.push(`The user wants the title to emphasize: ${hint.slice(0, MAX_HINT_CHARACTERS)}`)
  if (excerpt.truncated) lines.push('Some middle messages were omitted for length.')
  return lines.join('\n')
}

/**
 * Take the title from model output: the first non-empty line without wrapping
 * emphasis or quotes, as models that ignore the one-line rule still lead with it.
 * @param {string} output - assembled model text.
 * @returns the normalized title, possibly empty.
 */
function titleFromOutput(output) {
  const line = String(output)
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0) || ''
  const emphasized = EMPHASIS_WRAPPER.exec(line)
  const unquoted = (emphasized ? emphasized[2] : line).replace(QUOTE_WRAPPER, '').trim()
  const cleaned = cleanText(unquoted)
  return cleaned.length > MAX_TITLE_CHARACTERS ? cleaned.slice(0, MAX_TITLE_CHARACTERS).trimEnd() : cleaned
}

/**
 * Reject terminal outcomes that carry no usable title.
 * @param {object|undefined} finish - terminal finish reason of the stream.
 */
function assertUsableFinish(finish) {
  if (!finish) throw new Error('The title request ended without a result.')
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const failure = finish.failure || {}
    const message = typeof failure.message === 'string' && failure.message.length > 0 ? failure.message : undefined
    throw new Error(message !== undefined ? message : 'The title request was aborted.')
  }
  if (finish.kind === 'tool-calls') throw new Error('The model answered with a tool call instead of a title.')
}

/**
 * Select the least supported reasoning effort for one route, as the shipped
 * title provider does: the thinking that precedes a one-line title must not
 * consume the whole output budget.
 * @returns an effort id, or `undefined` when the route exposes none.
 */
async function resolveReasoningEffort(ctx, route, signal) {
  if (!ctx.llm || typeof ctx.llm.resolveModelInfo !== 'function') return undefined
  try {
    const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
    const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : []
    const first = efforts[0]
    return first && typeof first.id === 'string' && first.id.length > 0 ? first.id : undefined
  } catch {
    // An adapter that cannot describe its reasoning support still serves the call.
    return undefined
  }
}

/**
 * Stream one auxiliary title request and assemble its text.
 * @returns `{ text, finish }` with the terminal finish reason.
 */
async function generateTitleText(ctx, settings, session, route, excerpt, hint, signal) {
  const reasoningEffort = await resolveReasoningEffort(ctx, route, signal)
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
    system: buildSystemPrompt(settings),
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: buildUserInput(excerpt, hint) }],
    }],
    maxTokens: settings.maxOutputTokens,
    sessionId: session.id,
    purpose: 'session-title',
    signal,
  })
  let text = ''
  let finish
  const streamedIndexes = new Set()
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    switch (chunk.type) {
      case 'text-delta':
        if (typeof chunk.text === 'string' && chunk.text.length > 0) {
          text += chunk.text
          streamedIndexes.add(chunk.index)
        }
        break
      case 'block-end':
        if (chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string'
          && !streamedIndexes.has(chunk.index)) {
          text += chunk.block.text
        }
        break
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }
  assertUsableFinish(finish)
  return { text, finish }
}

/**
 * The one rename operation: analyze the conversation, generate a title, accept it.
 * @param {object} ctx - plugin context.
 * @param {object} settings - resolved settings.
 * @param {object} session - live session to rename.
 * @param {string} hint - optional user focus from command input.
 * @param {AbortSignal|undefined} signal - caller cancellation.
 * @returns `{ ok, title, previous, message }`.
 */
async function retitleSession(ctx, settings, session, hint, signal) {
  if (!ctx.sessionTitle || typeof ctx.sessionTitle.rename !== 'function') {
    return { ok: false, message: 'The session title service is unavailable in this profile.' }
  }
  const excerpt = buildExcerpt(session, settings)
  if (excerpt.entries.length === 0) {
    return { ok: false, message: 'This conversation has no text to name yet.' }
  }
  const route = resolveRoute(ctx, session, settings)
  if (!route) {
    return {
      ok: false,
      message: 'No model route is available to name this conversation. Send one message first or configure provider and model.',
    }
  }
  let previous
  try {
    const snapshot = ctx.sessionTitle.get(session)
    previous = snapshot && typeof snapshot.title === 'string' ? snapshot.title : undefined
  } catch {
    previous = undefined
  }

  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('title generation timed out')), settings.timeoutMs)
  const combined = combineSignals(signal, deadline.signal)
  try {
    const generated = await generateTitleText(ctx, settings, session, route, excerpt, hint, combined)
    const title = titleFromOutput(generated.text)
    if (title.length === 0) {
      const kind = generated.finish && typeof generated.finish.kind === 'string' ? generated.finish.kind : 'unknown'
      throw new Error(`The model returned no usable title (finish: ${kind}, text: ${generated.text.length} chars).`)
    }
    const accepted = ctx.sessionTitle.rename(session, title)
    return { ok: true, title: accepted.title, previous, message: `Renamed this conversation to "${accepted.title}".` }
  } catch (error) {
    const cancelled = deadline.signal.aborted || (signal !== undefined && signal.aborted)
    return {
      ok: false,
      message: cancelled ? 'Title generation was cancelled or timed out.' : describeError(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {unknown} error - thrown value.
 * @returns a human-readable reason.
 */
function describeError(error) {
  if (error && typeof error.message === 'string' && error.message.trim().length > 0) return error.message.trim()
  return String(error)
}

/**
 * Register the command and the tool over one shared operation.
 * @param {object} ctx - plugin context.
 * @param {unknown} config - row configuration.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)

  ctx.effect(() => ctx.commands.register({
    name: COMMAND_NAME,
    description: 'Rename this conversation from its current content. Optional text after the command focuses the new title.',
    async handler(invocation) {
      const session = sessionOf(ctx, invocation.agent)
      if (!session) return { kind: 'error', text: 'This conversation is not open in this process.' }
      const hint = typeof invocation.rawInput === 'string' ? cleanText(invocation.rawInput) : ''
      const outcome = await retitleSession(ctx, settings, session, hint, invocation.signal)
      if (!outcome.ok) return { kind: 'error', text: outcome.message }
      return {
        kind: 'success',
        text: outcome.previous === outcome.title
          ? `The title is already "${outcome.title}".`
          : `Renamed this conversation to "${outcome.title}".`,
      }
    },
  }), 'ai-retitle: retitle command')

  ctx.effect(() => ctx.tools.register({
    name: TOOL_NAME,
    description: 'Rename the current conversation from its current content, replacing the title generated from the first message. Use it when the conversation has moved on from its early topic. Returns the new title.',
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: 'Topic to emphasize in the title, such as "deployment". Omit to let the whole conversation decide.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The accepted title.' },
          previous: { type: 'string', description: 'The title it replaced, or an empty string.' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      render(args, value) {
        const title = value && typeof value.title === 'string' ? value.title : ''
        const previous = value && typeof value.previous === 'string' ? value.previous : ''
        return [{
          type: 'text',
          text: previous.length > 0 && previous !== title
            ? `Renamed this conversation from "${previous}" to "${title}".`
            : `This conversation is now titled "${title}".`,
        }]
      },
    },
    timeoutMs: settings.timeoutMs + 5000,
    async execute(args, exec) {
      const session = sessionOf(ctx, exec.agent)
      if (!session) throw new Error('This conversation is not open in this process.')
      const focus = args && typeof args.focus === 'string' ? cleanText(args.focus) : ''
      const outcome = await retitleSession(ctx, settings, session, focus, exec.signal)
      if (!outcome.ok) throw new Error(outcome.message)
      return { title: outcome.title, previous: outcome.previous === undefined ? '' : outcome.previous }
    },
  }), 'ai-retitle: retitle tool')
}
