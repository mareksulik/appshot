// A small copy of the screenshot for the preview above the prompt.
export type Thumb = {
  jpeg: string // base64, embedded in an SVG on the desktop
  png: string // path, read by the terminal's Image
  width: number
  height: number
}

export type Appshot = {
  id: string
  app: string
  title: string
  image: string | null
  text: string | null
  thumb?: Thumb | null
}

export type HelperStatus = 'starting' | 'compiling' | 'ready' | 'error' | 'off'

declare module 'claude-code' {
  interface PluginState {
    appshot: { pending: Appshot[]; status: HelperStatus; error: string | null }
  }
}
