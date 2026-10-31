// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer roughly doubles the web process's memory and
    // adds ~130 ms to first paint on software-GL machines (and blanks the
    // window on some NVIDIA drivers). WebGL is unaffected. Respect an explicit
    // user setting either way.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    radlearn_viewer_lib::run()
}
