// appshot helper: captures the frontmost window (image + accessibility text)
// and prints one JSON line per appshot on stdout.
//
//   appshot listen  <outDir> [sessionId]
//                              wait for both ⌘ keys pressed together; with a
//                              session id, capture only for the active session
//   appshot capture <outDir>   capture once, skipping the frontmost app's
//                              windows (the window behind Claude Code)
import ApplicationServices
import Cocoa

setvbuf(stdout, nil, _IOLBF, 0)

let maxChars = 150_000
let maxNodes = 40_000
let textRoles: Set<String> = ["AXStaticText", "AXTextArea", "AXTextField", "AXHeading", "AXLink", "AXCell"]

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

struct Target {
    let windowID: CGWindowID
    let pid: pid_t
    let app: String
    let title: String
}

// On-screen windows come front to back; layer 0 holds normal app windows.
func frontWindow(skipFrontApp: Bool) -> Target? {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return nil }
    var skipPid: pid_t?
    for info in list {
        guard (info[kCGWindowLayer as String] as? Int) == 0,
              let pid = info[kCGWindowOwnerPID as String] as? pid_t,
              let id = info[kCGWindowNumber as String] as? CGWindowID else { continue }
        let bounds = info[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
        if (bounds["Width"] ?? 0) < 80 || (bounds["Height"] ?? 0) < 80 { continue }
        if skipFrontApp {
            if skipPid == nil { skipPid = pid }
            if pid == skipPid { continue }
        }
        return Target(
            windowID: id,
            pid: pid,
            app: info[kCGWindowOwnerName as String] as? String ?? "Unknown",
            title: info[kCGWindowName as String] as? String ?? ""
        )
    }
    return nil
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func windowText(pid: pid_t) -> String {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.5)
    // Chromium and Electron expose web content only when asked to.
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let window = attribute(app, kAXFocusedWindowAttribute) ?? attribute(app, kAXMainWindowAttribute)
    guard let root = window else { return "" }

    var lines: [String] = []
    var chars = 0
    var visited = 0
    var stack: [AXUIElement] = [root as! AXUIElement]
    while let element = stack.popLast(), visited < maxNodes, chars < maxChars {
        visited += 1
        let role = attribute(element, kAXRoleAttribute) as? String ?? ""
        if textRoles.contains(role), let text = attribute(element, kAXValueAttribute) as? String {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty && trimmed != lines.last {
                lines.append(trimmed)
                chars += trimmed.count
            }
        }
        if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
            stack.append(contentsOf: children.reversed())
        }
    }
    return String(lines.joined(separator: "\n").prefix(maxChars))
}

func capture(outDir: String, skipFrontApp: Bool) {
    guard let target = frontWindow(skipFrontApp: skipFrontApp) else {
        emit(["type": "error", "message": "No window to capture"])
        return
    }
    let stamp = Int(Date().timeIntervalSince1970 * 1000)
    let imagePath = "\(outDir)/appshot-\(stamp).png"
    let shot = Process()
    shot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    shot.arguments = ["-x", "-o", "-l", String(target.windowID), imagePath]
    try? shot.run()
    shot.waitUntilExit()
    let hasImage = FileManager.default.fileExists(atPath: imagePath)

    emit([
        "type": "appshot",
        "id": String(stamp),
        "app": target.app,
        "title": target.title,
        "image": hasImage ? imagePath : NSNull(),
        "text": AXIsProcessTrusted() ? windowText(pid: target.pid) : NSNull(),
    ])
}

func permissions() -> [String: Any] {
    return [
        "type": "permissions",
        "accessibility": AXIsProcessTrusted(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "inputMonitoring": CGPreflightListenEventAccess(),
    ]
}

// NX_DEVICELCMDKEYMASK / NX_DEVICERCMDKEYMASK: left and right ⌘ separately.
let leftCommand: UInt64 = 0x08
let rightCommand: UInt64 = 0x10
var isArmed = true
var outDir = ""
var sessionId = ""
var baseDir = ""

func readTrimmed(_ path: String) -> String {
    let text = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
}

// Each listening session leaves sessions/<id> holding its helper's pid.
func isAlive(_ session: String) -> Bool {
    guard let pid = pid_t(readTrimmed("\(baseDir)/sessions/\(session)")) else { return false }
    return kill(pid, 0) == 0
}

func startedAt(_ session: String) -> Date {
    let attributes = try? FileManager.default.attributesOfItem(atPath: "\(baseDir)/sessions/\(session)")
    return attributes?[.modificationDate] as? Date ?? .distantPast
}

// Every open session runs a helper; only one may take the appshot: the session
// last used (its mod writes `active`), else the newest one still running.
func isMine() -> Bool {
    if sessionId.isEmpty { return true }
    let active = readTrimmed("\(baseDir)/active")
    if active == sessionId { return true }
    if !active.isEmpty && isAlive(active) { return false }
    let sessions = (try? FileManager.default.contentsOfDirectory(atPath: "\(baseDir)/sessions")) ?? []
    let newest = sessions.filter(isAlive).max { startedAt($0) < startedAt($1) }
    return newest == sessionId
}

func registerSession() {
    guard !sessionId.isEmpty else { return }
    let dir = "\(baseDir)/sessions"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try? String(getpid()).write(toFile: "\(dir)/\(sessionId)", atomically: true, encoding: .utf8)
}

func listen() {
    let callback: CGEventTapCallBack = { _, type, event, _ in
        if type == .flagsChanged {
            let raw = event.flags.rawValue
            let isBoth = raw & leftCommand != 0 && raw & rightCommand != 0
            if isBoth && isArmed {
                isArmed = false
                DispatchQueue.main.async { if isMine() { capture(outDir: outDir, skipFrontApp: false) } }
            } else if !isBoth {
                isArmed = true
            }
        }
        return Unmanaged.passUnretained(event)
    }
    let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
        eventsOfInterest: mask, callback: callback, userInfo: nil
    ) else {
        emit(["type": "error", "message": "Cannot listen for the hotkey: allow Input Monitoring for the app that runs Claude Code, then run /appshot restart"])
        exit(2)
    }
    CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    emit(["type": "ready"])
    CFRunLoopRun()
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: appshot listen|capture|permissions <outDir>\n".data(using: .utf8)!)
    exit(64)
}
outDir = args[2]
baseDir = (outDir as NSString).deletingLastPathComponent
sessionId = args.count > 3 ? args[3] : ""
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

switch args[1] {
case "listen":
    registerSession()
    emit(permissions())
    listen()
case "capture":
    capture(outDir: outDir, skipFrontApp: true)
case "permissions":
    // Raises the system prompts for the permissions not yet granted.
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    if !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
    emit(permissions())
default:
    exit(64)
}
