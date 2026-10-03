# appshot

Press **both ⌘ keys at once** in any app to hand Claude the window you are looking at. appshot captures the frontmost window as a screenshot and reads its text through the macOS Accessibility API, including text that is scrolled out of view. The appshot shows as a thumbnail above the Claude Code prompt and is attached to your next message, so you can ask "what's wrong with this form?" without copying anything.

appshot is a Claude Code mod: it runs in the Claude Code terminal and in the Code tab of the Claude desktop app. It works on **macOS only**.

## Usage

- **⌘ + ⌘** (left and right Command together) in any app: take an appshot of the frontmost window.
- **`/appshot`**: take an appshot of the window right behind Claude Code.
- Click **🔍** on a thumbnail to open the full screenshot in Preview, **✕** to drop it.

| Command | What it does |
| --- | --- |
| `/appshot attach` | Hotkey appshots wait for your next prompt (default) |
| `/appshot send` | Hotkey appshots are sent to Claude at once |
| `/appshot sound <name>` | Capture sound: `screenshot`, `shutter`, `pop`, `glass`, `bottle`, `purr`, `tink` or `off` |
| `/appshot clear` | Drop all pending appshots |
| `/appshot permissions` | Ask macOS for the permissions appshot needs |
| `/appshot restart` | Restart the hotkey listener |
| `/appshot status` | Show settings and listener state |

With several Claude Code sessions open, an appshot goes to the session you used last. A brand-new session takes over appshots made in the last five minutes that were not sent yet, because the desktop app starts a session's process only with its first message.

## Requirements and permissions

- macOS with the Xcode Command Line Tools (`xcode-select --install`), which provide `swiftc`.
- In **System Settings › Privacy & Security**, allow the app that runs Claude Code (Claude, Terminal, iTerm…) under **Accessibility** (window text), **Screen Recording** (screenshot) and **Input Monitoring** (the hotkey). `/appshot permissions` raises the system prompts.

## What appshot runs, stores and sends

Everything stays on your Mac. appshot makes **no network requests** and sends nothing anywhere except into your own Claude Code conversation, and only when you submit a prompt with an appshot attached.

- **Helper program.** On first start the mod compiles `helper/appshot.swift`, readable source in this repository, with `swiftc` into `~/.claude/appshot/bin/appshot`, and recompiles it when the source changes. One helper runs per open session and stops with it.
- **Hotkey.** The helper listens only to modifier-key changes (`flagsChanged` events) to notice both ⌘ keys held together. It does not see or record what you type.
- **Screenshot.** It runs macOS `screencapture -l <window id>` on the frontmost window, or on the window behind Claude Code for `/appshot`.
- **Window text.** It reads the text of that app's focused window through the Accessibility API, at most 150,000 characters. For Chromium and Electron apps it turns on `AXManualAccessibility` so that page text is exposed.
- **Files.** Screenshots, thumbnails and pending appshots are written to `~/.claude/appshot/`. The `active` file and the `sessions/` folder record which session should receive the next appshot. Delete the folder at any time.
- **Other commands.** `sips` and `base64` make the thumbnail, `afplay` plays the capture sound, and `open` shows a screenshot in Preview.
- **What Claude receives.** When you send a prompt, each pending appshot is added as context: the app name, the window title, the path of the screenshot (Claude opens it with its Read tool when the layout matters) and the window text.

The window text and screenshot can contain anything that window shows, including private information, so take an appshot only of windows you mean to share with Claude.

## License

MIT
