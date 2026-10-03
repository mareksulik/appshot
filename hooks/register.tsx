import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Appshot, HelperStatus, Thumb } from '../types'

const pending = atom({ plugin: 'appshot', key: 'pending' } as const, [] as Appshot[])
const status = atom({ plugin: 'appshot', key: 'status' } as const, 'off' as HelperStatus)
const lastError = atom({ plugin: 'appshot', key: 'error' } as const, null as string | null)

type Destination = 'attach' | 'send'

const SYSTEM_SOUNDS = '/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system'
const SOUNDS: Record<string, string> = {
  screenshot: `${SYSTEM_SOUNDS}/Screen Capture.aif`,
  shutter: `${SYSTEM_SOUNDS}/Shutter.aif`,
  pop: '/System/Library/Sounds/Pop.aiff',
  glass: '/System/Library/Sounds/Glass.aiff',
  bottle: '/System/Library/Sounds/Bottle.aiff',
  purr: '/System/Library/Sounds/Purr.aiff',
  tink: '/System/Library/Sounds/Tink.aiff',
}
const DEFAULT_SOUND = 'screenshot'

const USAGE = [
  '/appshot              capture the window behind Claude Code now',
  '/appshot attach|send  hotkey adds the appshot to your next prompt, or sends it at once',
  `/appshot sound <name> sound on capture: ${Object.keys(SOUNDS).join(', ')}, off`,
  '/appshot clear        drop pending appshots',
  '/appshot permissions  ask macOS for Accessibility, Screen Recording, Input Monitoring',
  '/appshot restart      restart the ⌘+⌘ listener',
  '/appshot status       show settings and listener state',
].join('\n')

let paths = { base: '', bin: '', shots: '', src: '' }
let listener: { return?: () => unknown } | null = null
let generation = 0
let claimTimer: { cancel: () => void } | null = null

async function destination($: EngineInterface): Promise<Destination> {
  return (await $.store.get('destination')) === 'send' ? 'send' : 'attach'
}

// The chosen sound's name, or 'off'. Older versions stored a boolean.
async function soundName($: EngineInterface): Promise<string> {
  const stored = await $.store.get('sound')
  if (stored === false || stored === 'off') return 'off'
  return typeof stored === 'string' && stored in SOUNDS ? stored : DEFAULT_SOUND
}

async function playSound($: EngineInterface, name: string) {
  if (name in SOUNDS) await $.process.run(['afplay', SOUNDS[name]]).catch(() => {})
}

async function resolvePaths($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? '/tmp'
  const base = `${home}/.claude/appshot`
  paths = { base, bin: `${base}/bin/appshot`, shots: `${base}/shots`, src: `${$.plugin.root}/helper/appshot.swift` }
}

// Marks this session as the one ⌘+⌘ appshots go to (the helpers of the other
// open sessions read the same file and stand aside).
async function markActive($: EngineInterface) {
  await $.fs.write(`${paths.base}/active`, await $.session.id()).catch(() => {})
}

// Compiles the Swift helper when it is missing or older than its source.
async function ensureHelper($: EngineInterface) {
  const isFresh =
    (await $.fs.exists(paths.bin)) &&
    (await $.fs.stat(paths.bin)).mtimeMs >= (await $.fs.stat(paths.src)).mtimeMs
  if (isFresh) return

  await update($, status, () => 'compiling')
  await $.process.run(['mkdir', '-p', paths.bin.replace(/\/appshot$/, ''), paths.shots])
  const built = await $.process.run(
    ['swiftc', '-O', '-swift-version', '5', '-o', paths.bin, paths.src],
    { timeoutMs: 300_000 },
  )
  if (built.exitCode !== 0) throw new Error(`swiftc failed: ${built.stderr.slice(0, 400)}`)
}

function toContext(shot: Appshot): string {
  const lines = [`<appshot app="${shot.app}" window="${shot.title}">`]
  if (shot.image) {
    lines.push(`Screenshot of the window: ${shot.image}`)
    lines.push('Read that PNG with the Read tool whenever the visual layout or images matter.')
  }
  if (shot.text) {
    lines.push('Text content of the window from the accessibility tree, including text scrolled offscreen:')
    lines.push(shot.text)
  }
  lines.push('</appshot>')
  return lines.join('\n')
}

// Writes a small JPEG (for the desktop's Svg) and PNG (for the terminal's
// Image) beside the screenshot; null when sips fails.
async function makeThumb($: EngineInterface, image: string): Promise<Thumb | null> {
  const base = image.replace(/\.png$/, '')
  const jpeg = `${base}.thumb.jpg`
  const png = `${base}.thumb.png`
  const madeJpeg = await $.process.run(['sips', '-Z', '480', '-s', 'format', 'jpeg', '-s', 'formatOptions', '55', image, '--out', jpeg])
  const madePng = await $.process.run(['sips', '-Z', '480', image, '--out', png])
  if (madeJpeg.exitCode !== 0 || madePng.exitCode !== 0) return null

  const size = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', jpeg])
  const width = Number(size.stdout.match(/pixelWidth: (\d+)/)?.[1] ?? 0)
  const height = Number(size.stdout.match(/pixelHeight: (\d+)/)?.[1] ?? 0)
  const encoded = await $.process.run(['base64', '-i', jpeg])
  if (!width || !height || encoded.exitCode !== 0) return null

  return { jpeg: encoded.stdout.replace(/\s+/g, ''), png, width, height }
}

const CARD_WIDTH = 200
const CAPTION_HEIGHT = 34

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`)
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function shotMeta(shot: Appshot): string {
  const text = shot.text ? `${Math.round(shot.text.length / 100) / 10}k chars` : 'no text'
  return `${shot.app} · ${text}`
}

const CAPTION_WIDTH = CARD_WIDTH - 52 // room for the 🔍 and ✕ buttons
const FONT = 'font-family="-apple-system, system-ui, sans-serif"'

function thumbHeight(thumb: Thumb): number {
  return Math.round((CARD_WIDTH * thumb.height) / thumb.width)
}

function imageSvg(thumb: Thumb): string {
  const w = CARD_WIDTH
  const height = thumbHeight(thumb)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${height}" width="${w}" height="${height}">`,
    `<clipPath id="r"><rect width="${w}" height="${height}" rx="6"/></clipPath>`,
    `<image href="data:image/jpeg;base64,${thumb.jpeg}" width="${w}" height="${height}" clip-path="url(#r)" preserveAspectRatio="xMidYMid slice"/>`,
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${height - 1}" rx="6" fill="none" stroke="#8e8e93" stroke-opacity="0.35"/>`,
    '</svg>',
  ].join('')
}

// Title and meta in small type, an SVG because Text has no font size.
function captionSvg(shot: Appshot): string {
  const w = CAPTION_WIDTH
  const title = escapeXml(truncate(shot.title || shot.app, 22))
  const meta = escapeXml(truncate(shotMeta(shot), 28))
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${CAPTION_HEIGHT}" width="${w}" height="${CAPTION_HEIGHT}">`,
    '<style>.t{fill:#3c3c43}.m{fill:#8e8e93}@media (prefers-color-scheme: dark){.t{fill:#e5e5ea}}</style>',
    `<text class="t" x="1" y="14" ${FONT} font-size="11" font-weight="600" fill="#8e8e93">${title}</text>`,
    `<text class="m" x="1" y="28" ${FONT} font-size="10" fill="#8e8e93">${meta}</text>`,
    '</svg>',
  ].join('')
}

// Pending appshots are also kept as files, one per shot with its owning
// session, so a new session can take over the ones made before it existed.
const CLAIM_WINDOW_MS = 5 * 60_000

function pendingPath(id: string): string {
  return `${paths.base}/pending/${id}.json`
}

async function savePending($: EngineInterface, shot: Appshot) {
  await $.fs.write(pendingPath(shot.id), JSON.stringify({ owner: await $.session.id(), shot })).catch(() => {})
}

async function dropPending($: EngineInterface, shots: readonly Appshot[]) {
  if (shots.length === 0) return
  await $.process.run(['rm', '-f', ...shots.map(shot => pendingPath(shot.id))]).catch(() => {})
}

// Desktop starts a session's process with its first message, so appshots taken
// on a fresh "New session" screen land in the session used before. A brand-new
// session takes the recent ones still pending there, for its first prompt.
async function claimRecent($: EngineInterface) {
  if ((await $.session.turns()) > 0) return
  const me = await $.session.id()
  const now = await $.clock.now()
  const entries = await $.fs.list(`${paths.base}/pending`).catch(() => [])
  const claimed: Appshot[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    const record = await $.fs.read(`${paths.base}/pending/${entry.name}`).then(JSON.parse).catch(() => null)
    if (!record || record.owner === me || now - Number(record.shot.id) > CLAIM_WINDOW_MS) continue
    await $.fs.write(pendingPath(record.shot.id), JSON.stringify({ owner: me, shot: record.shot }))
    claimed.push(record.shot)
  }
  if (claimed.length > 0) await update($, pending, list => [...list, ...claimed])
}

// Drops from this session's band the appshots another session took over.
async function forgetClaimed($: EngineInterface) {
  const shots = await read($, pending)
  if (shots.length === 0) return
  const me = await $.session.id()
  const kept: Appshot[] = []
  for (const shot of shots) {
    const owner = await $.fs.read(pendingPath(shot.id)).then(text => JSON.parse(text).owner).catch(() => null)
    if (owner === me) kept.push(shot)
  }
  if (kept.length !== shots.length) await update($, pending, () => kept)
}

async function onAppshot($: EngineInterface, shot: Appshot) {
  if (!shot.image && !shot.text) {
    $.ui.toast(`Appshot of ${shot.app} came back empty: run /appshot permissions`)
    return
  }
  void playSound($, await soundName($))

  const thumb = shot.image ? await makeThumb($, shot.image).catch(() => null) : null
  await savePending($, { ...shot, thumb })
  await update($, pending, list => [...list, { ...shot, thumb }])
  const label = shot.title ? `${shot.app} — ${shot.title}` : shot.app
  if ((await destination($)) === 'send') {
    void $.prompt.submit({ text: `Here's an appshot of my ${label} window.`, asUser: true })
  }
}

async function handleLine($: EngineInterface, line: string) {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.type === 'ready') {
    await update($, status, () => 'ready')
    await update($, lastError, () => null)
  } else if (message.type === 'error') {
    await update($, lastError, () => message.message)
    $.ui.toast(`Appshot: ${message.message}`)
  } else if (message.type === 'appshot') {
    await onAppshot($, message as Appshot)
  }
}

async function startListener($: EngineInterface) {
  listener?.return?.()
  const mine = ++generation
  await update($, status, () => 'starting')
  try {
    await ensureHelper($)
    const child = $.process.spawn({ argv: [paths.bin, 'listen', paths.shots, await $.session.id()] })
    listener = child as unknown as { return?: () => unknown }
    let buffer = ''
    for await (const { stream, text } of child) {
      if (stream === 'stderr') continue
      buffer += text
      let end = buffer.indexOf('\n')
      while (end >= 0) {
        await handleLine($, buffer.slice(0, end)).catch(() => {})
        buffer = buffer.slice(end + 1)
        end = buffer.indexOf('\n')
      }
    }
    if (mine === generation) await update($, status, () => 'error')
  } catch (error) {
    if (mine !== generation) return
    await update($, status, () => 'error')
    await update($, lastError, () => String(error))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await resolvePaths($)
    await $.command.register({
      name: 'appshot',
      description: 'Send Claude the window behind Claude Code (⌘+⌘ works from any app)',
      argumentHint: '[attach|send|sound <name>|clear|permissions|restart|status]',
      immediate: true,
    })
    await markActive($)
    await claimRecent($)
    claimTimer?.cancel()
    claimTimer = $.clock.every(1500, () => forgetClaimed($))
    void startListener($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    generation += 1
    listener?.return?.()
    claimTimer?.cancel()
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await markActive($)
    const shots = await read($, pending)
    if (shots.length === 0) return next(e)

    await update($, pending, () => [])
    await dropPending($, shots)
    return next({ ...e, context: [...(e.context ?? []), ...shots.map(toContext)] })
  })

  on('command.run', { command: 'appshot' }, async ($, e) => {
    const [verb = '', value = ''] = e.args.trim().split(/\s+/)
    await markActive($)

    if (verb === '') {
      await ensureHelper($)
      const shot = await $.process.run([paths.bin, 'capture', paths.shots], { timeoutMs: 20_000 })
      const line = shot.stdout.trim().split('\n').pop() ?? ''
      await handleLine($, line)
      return { text: line.includes('"appshot"') ? 'Appshot taken.' : `Appshot failed: ${line || shot.stderr}` }
    }
    if (verb === 'attach' || verb === 'send') {
      await $.store.set('destination', verb)
      return { text: verb === 'send' ? '⌘+⌘ now sends the appshot at once.' : '⌘+⌘ now adds the appshot to your next prompt.' }
    }
    if (verb === 'sound') {
      const name = value === 'on' || value === '' ? DEFAULT_SOUND : value
      if (name !== 'off' && !(name in SOUNDS)) {
        return { text: `Unknown sound. Pick one of: ${Object.keys(SOUNDS).join(', ')}, off` }
      }
      await $.store.set('sound', name)
      void playSound($, name)
      return { text: `Sound: ${name}.` }
    }
    if (verb === 'clear') {
      await dropPending($, await read($, pending))
      await update($, pending, () => [])
      return { text: 'Pending appshots cleared.' }
    }
    if (verb === 'permissions') {
      await ensureHelper($)
      const asked = await $.process.run([paths.bin, 'permissions', paths.shots], { timeoutMs: 20_000 })
      void startListener($)
      return { text: `macOS asked for what was missing; grant it in System Settings › Privacy & Security, then run /appshot restart.\n${asked.stdout.trim()}` }
    }
    if (verb === 'restart') {
      void startListener($)
      return { text: 'Restarting the ⌘+⌘ listener.' }
    }
    if (verb === 'status') {
      const error = await read($, lastError)
      return {
        text: [
          `Listener: ${await read($, status)}${error ? ` (${error})` : ''}`,
          `Destination: ${await destination($)}`,
          `Sound: ${await soundName($)}`,
          `Pending: ${(await read($, pending)).length}`,
          `Screenshots: ${paths.shots}`,
        ].join('\n'),
      }
    }
    return { text: USAGE }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shots = await read($, pending)
    if (shots.length === 0 || e.props.hasSurvey) return next(e)

    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements

    const remove = async (shot: Appshot) => {
      await dropPending($, [shot])
      await update($, pending, list => list.filter(one => one.id !== shot.id))
    }
    const actions = (shot: Appshot) => (
      <Box flexDirection="row" gap={1}>
        {shot.image && (
          <Button key={`open-${shot.id}`} label="🔍" plain onPress={() => void $.process.run(['open', shot.image as string])} />
        )}
        <Button key={`remove-${shot.id}`} label="✕" plain onPress={() => remove(shot)} />
      </Box>
    )

    // The image, and under it the caption with the buttons aligned right.
    const card = (shot: Appshot) => {
      if ('Svg' in elements) {
        return (
          <Box key={shot.id} flexDirection="column">
            {shot.thumb && (
              <elements.Svg source={imageSvg(shot.thumb)} alt={`Appshot: ${shot.title || shot.app}`} width={CARD_WIDTH} height={thumbHeight(shot.thumb)} />
            )}
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <elements.Svg source={captionSvg(shot)} alt={`${shot.title || shot.app}, ${shotMeta(shot)}`} width={CAPTION_WIDTH} height={CAPTION_HEIGHT} />
              {actions(shot)}
            </Box>
          </Box>
        )
      }
      const columns = 28
      const rows = shot.thumb ? Math.min(12, Math.max(4, Math.round((columns * shot.thumb.height) / shot.thumb.width / 2.1))) : 0
      return (
        <Box key={shot.id} flexDirection="column" width={columns}>
          {'Image' in elements && shot.thumb && (
            <elements.Image key={`thumb-${shot.id}`} source={{ file: shot.thumb.png, format: 'png' }} columns={columns} rows={rows} alt={`[${shot.app}]`} />
          )}
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="column" flexShrink={1}>
              <Text bold wrap="truncate-end">{shot.title || shot.app}</Text>
              <Text dimColor wrap="truncate-end">{shotMeta(shot)}</Text>
            </Box>
            {actions(shot)}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" gap={2}>
        {shots.map(card)}
      </Box>
    )
  })
}
