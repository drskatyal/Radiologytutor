// Control for the macOS cold-start gate: a bare WKWebView app, no FlowRad
// code. It prints the same marks the app reports (ms since process start):
// window built, page load start (provisional navigation), page loaded. Run
// next to `bench.mjs coldstart` on the same runner, it separates "this
// runner's WKWebView is slow right now" from "our start-up got slower".
//
//   swiftc -O desktop/scripts/wk-baseline.swift -o wk-baseline && ./wk-baseline
//
// Prints one JSON line and exits.

import AppKit
import WebKit

// Process start (kinfo_proc p_starttime), as the app's marks use.
func processStartSeconds() -> Double {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    sysctl(&mib, 4, &info, &size, nil, 0)
    let t = info.kp_proc.p_starttime
    return Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000
}

let started = processStartSeconds()
func sinceStart() -> Double { (Date().timeIntervalSince1970 - started) * 1000 }

final class Probe: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var marks: [String: Double] = [:]

    func applicationDidFinishLaunching(_ note: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        let web = WKWebView(frame: window.contentView!.bounds, configuration: WKWebViewConfiguration())
        web.navigationDelegate = self
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        marks["windowBuiltMs"] = sinceStart()
        web.loadHTMLString("<!doctype html><title>baseline</title><body style='background:#000'>", baseURL: nil)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        marks["navStartMs"] = sinceStart()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        marks["navDoneMs"] = sinceStart()
        let json = marks.map { "\"\($0.key)\": \(Int($0.value.rounded()))" }.sorted().joined(separator: ", ")
        print("{\(json)}")
        fflush(stdout)
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let probe = Probe()
app.delegate = probe
app.setActivationPolicy(.regular)
// Give up after 20 s rather than hang the job.
DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
    print("{\"timedOut\": true}")
    exit(1)
}
app.run()
