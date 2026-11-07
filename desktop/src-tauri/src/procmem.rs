//! Memory of this app's whole process tree (the exe plus every WebView2 /
//! WebKit child: browser, renderer, GPU, utility), for the debug memory HUD
//! and the leak test. Working set (resident) per process, in MB.

use std::collections::HashMap;

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Serialize)]
pub struct ProcMem {
    pub name: String,
    pub mb: u64,
}

#[derive(Serialize)]
pub struct TreeMem {
    #[serde(rename = "totalMb")]
    pub total_mb: u64,
    pub processes: Vec<ProcMem>,
}

/// `root` and all of its descendants. Pure over a (pid, parent, name, bytes) list for tests.
pub fn tree_of(root: u32, all: &[(u32, Option<u32>, String, u64)]) -> TreeMem {
    let mut members = vec![root];
    let mut grew = true;
    while grew {
        grew = false;
        for (pid, parent, _, _) in all {
            if let Some(p) = parent {
                if members.contains(p) && !members.contains(pid) {
                    members.push(*pid);
                    grew = true;
                }
            }
        }
    }
    let mut processes: Vec<ProcMem> = all
        .iter()
        .filter(|(pid, ..)| members.contains(pid))
        .map(|(_, _, name, bytes)| ProcMem { name: name.clone(), mb: bytes / 1_048_576 })
        .collect();
    processes.sort_by(|a, b| b.mb.cmp(&a.mb));
    TreeMem { total_mb: processes.iter().map(|p| p.mb).sum(), processes }
}

/// "msedgewebview2.exe (gpu-process)": the Chromium role from `--type=`, so a
/// report says WHICH WebView2 process holds the memory (the browser process
/// has no --type).
pub fn labelled(name: &str, cmd: &[String]) -> String {
    match cmd.iter().find_map(|a| a.strip_prefix("--type=")) {
        Some(kind) => {
            let kind = if kind == "utility" {
                cmd.iter().find_map(|a| a.strip_prefix("--utility-sub-type=")).map(|s| s.rsplit('.').next().unwrap_or(s)).unwrap_or(kind)
            } else {
                kind
            };
            format!("{name} ({kind})")
        }
        None => name.to_string(),
    }
}

pub fn current_tree() -> TreeMem {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().with_cmd(sysinfo::UpdateKind::OnlyIfNotSet),
    );
    #[allow(unused_mut)]
    let mut all: Vec<(u32, Option<u32>, String, u64)> = sys
        .processes()
        .iter()
        // Linux lists every thread as a task with the process's own RSS.
        .filter(|(_, p)| p.thread_kind().is_none())
        .map(|(pid, p)| {
            let name = p.name().to_string_lossy().into_owned();
            let cmd: Vec<String> = p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();
            (pid.as_u32(), p.parent().map(Pid::as_u32), labelled(&name, &cmd), p.memory())
        })
        .collect();
    #[cfg(target_os = "macos")]
    mac_tree(&sys, &mut all);
    tree_of(std::process::id(), &all)
}

/// macOS: the same tree the bench measures (desktop/scripts/bench.mjs
/// `treeMemoryMac`). WKWebView's WebContent / GPU / Networking processes are
/// launchd's children, not ours, so every com.apple.WebKit.* process started
/// after the app joins the tree. Each process counts its physical footprint
/// (Activity Monitor's "Memory"), not RSS: RSS keeps the pages mimalloc hands
/// back with MADV_FREE_REUSABLE (a closed study's volume stayed "resident"),
/// and on Apple silicon the footprint also covers the process's Metal memory.
#[cfg(target_os = "macos")]
fn mac_tree(sys: &System, all: &mut [(u32, Option<u32>, String, u64)]) {
    let me = std::process::id();
    let born = sys.process(Pid::from_u32(me)).map(|p| p.start_time()).unwrap_or(0);
    for entry in all.iter_mut() {
        let Some(p) = sys.process(Pid::from_u32(entry.0)) else { continue };
        if entry.0 != me && entry.2.starts_with("com.apple.WebKit.") && p.start_time() >= born {
            entry.1 = Some(me);
        }
        if let Some(bytes) = footprint_of(entry.0) {
            entry.3 = bytes;
        }
    }
}

/// A process's physical footprint, bytes (proc_pid_rusage, same user only).
#[cfg(target_os = "macos")]
fn footprint_of(pid: u32) -> Option<u64> {
    let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a rusage_info_v2, the flavour asked for.
    let rc = unsafe { libc::proc_pid_rusage(pid as libc::c_int, libc::RUSAGE_INFO_V2, &mut info as *mut libc::rusage_info_v2 as *mut libc::rusage_info_t) };
    (rc == 0).then_some(info.ri_phys_footprint)
}

// ───────────── this process's private bytes, by owner (bench reports) ─────────────

/// What the app process's private bytes are made of (bench close / memory
/// reports): the Rust heap (mimalloc), the Windows heaps (the process heap,
/// and the heaps D3D12, the driver and the WebView2 host allocate from),
/// thread stacks, pages written in loaded DLLs, and whatever else was
/// VirtualAlloc'd: on Windows that is mostly the GPU runtime (D3D12 / driver
/// / WARP allocations: descriptor heaps, swap chain and resources on WARP or
/// an integrated GPU). `top` names the biggest of those allocations, `modules`
/// the DLLs with the most written pages, so a report says WHAT holds memory.
#[derive(Serialize, Default, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppMemory {
    pub private_mb: f64,
    /// mimalloc's committed bytes (None: no stats).
    pub heap_mb: Option<f64>,
    pub win_heaps_mb: f64,
    pub win_heaps: usize,
    pub stacks_mb: f64,
    pub threads: usize,
    pub image_written_mb: f64,
    /// Committed private allocations not accounted for above (approximate:
    /// private committed − heaps − stacks − mimalloc).
    pub other_private_mb: f64,
    pub top: Vec<Allocation>,
    pub modules: Vec<(String, f64)>,
}

#[derive(Serialize, Default, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Allocation {
    pub committed_mb: f64,
    pub reserved_mb: f64,
}

/// One region of the address space (VirtualQuery), as the breakdown needs it.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(not(windows), allow(dead_code))] // walked on Windows only; tests use it everywhere
pub struct Region {
    pub allocation_base: usize,
    pub size: usize,
    pub committed: bool,
    pub kind: RegionKind,
    /// An image page that was written (copy-on-write made it private).
    pub written: bool,
    /// A guard page (the growth edge of a thread stack).
    pub guard: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum RegionKind {
    Private,
    Image,
    Mapped,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn mb(bytes: usize) -> f64 {
    (bytes as f64 / 1_048_576.0 * 10.0).round() / 10.0
}

/// The breakdown from a region walk. Pure, for tests: `private_bytes` is the
/// OS's private-bytes count, `win_heaps` the Windows heaps' committed bytes,
/// `heap_mb` mimalloc's, `module_name` names an image by its base.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn breakdown(
    regions: &[Region],
    private_bytes: usize,
    win_heaps: (usize, usize),
    heap_mb: Option<f64>,
    module_name: &dyn Fn(usize) -> String,
) -> AppMemory {
    // Per allocation (reservation): committed, reserved, and whether it holds
    // a guard page (a stack).
    let mut allocs: HashMap<usize, (usize, usize, bool)> = HashMap::new();
    let mut images: HashMap<usize, usize> = HashMap::new();
    for r in regions {
        match r.kind {
            RegionKind::Private => {
                let a = allocs.entry(r.allocation_base).or_default();
                a.1 += r.size;
                if r.committed {
                    a.0 += r.size;
                }
                a.2 |= r.guard;
            }
            RegionKind::Image if r.committed && r.written => *images.entry(r.allocation_base).or_default() += r.size,
            _ => {}
        }
    }
    let (mut stacks, mut threads, mut private) = (0usize, 0usize, 0usize);
    let mut rest: Vec<Allocation> = Vec::new();
    for (committed, reserved, guard) in allocs.values().copied() {
        private += committed;
        if guard {
            stacks += committed;
            threads += 1;
        } else if committed > 0 {
            rest.push(Allocation { committed_mb: mb(committed), reserved_mb: mb(reserved) });
        }
    }
    rest.sort_by(|a, b| b.committed_mb.total_cmp(&a.committed_mb));
    rest.truncate(8);
    let mut modules: Vec<(String, f64)> = images.iter().map(|(base, bytes)| (module_name(*base), mb(*bytes))).collect();
    modules.sort_by(|a, b| b.1.total_cmp(&a.1));
    modules.truncate(8);
    let image_written: usize = images.values().sum();
    let other = private as f64 - win_heaps.0 as f64 - stacks as f64 - heap_mb.unwrap_or(0.0) * 1_048_576.0;
    AppMemory {
        private_mb: mb(private_bytes),
        heap_mb,
        win_heaps_mb: mb(win_heaps.0),
        win_heaps: win_heaps.1,
        stacks_mb: mb(stacks),
        threads,
        image_written_mb: mb(image_written),
        other_private_mb: mb(other.max(0.0) as usize),
        top: rest,
        modules,
    }
}

/// This process's breakdown now. Windows: a VirtualQuery walk of the address
/// space plus the heaps' own summaries. Elsewhere: private bytes and the heap.
pub fn app_memory() -> AppMemory {
    #[cfg(windows)]
    {
        win::app_memory()
    }
    #[cfg(not(windows))]
    {
        AppMemory { private_mb: crate::commit_mb(), heap_mb: crate::heap_committed_mb(), ..Default::default() }
    }
}

#[cfg(windows)]
mod win {
    use super::{breakdown, AppMemory, Region, RegionKind};
    use windows_sys::Win32::System::LibraryLoader::GetModuleFileNameW;
    use windows_sys::Win32::System::Memory::{
        GetProcessHeaps, HeapSummary, VirtualQuery, HEAP_SUMMARY, MEMORY_BASIC_INFORMATION, MEM_COMMIT, MEM_IMAGE, MEM_MAPPED, MEM_PRIVATE,
        PAGE_EXECUTE_READWRITE, PAGE_GUARD, PAGE_READWRITE,
    };
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    pub fn app_memory() -> AppMemory {
        let regions = regions();
        breakdown(&regions, private_bytes(), heaps(), crate::heap_committed_mb(), &module_name)
    }

    fn regions() -> Vec<Region> {
        let mut out = Vec::new();
        let mut addr: usize = 0;
        loop {
            // SAFETY: VirtualQuery only reads this process's page tables into `mbi`.
            let mut mbi: MEMORY_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
            let n = unsafe { VirtualQuery(addr as *const _, &mut mbi, std::mem::size_of::<MEMORY_BASIC_INFORMATION>()) };
            if n == 0 || mbi.RegionSize == 0 {
                break;
            }
            let kind = match mbi.Type {
                MEM_PRIVATE => Some(RegionKind::Private),
                MEM_IMAGE => Some(RegionKind::Image),
                MEM_MAPPED => Some(RegionKind::Mapped),
                _ => None, // free
            };
            if let Some(kind) = kind {
                out.push(Region {
                    allocation_base: mbi.AllocationBase as usize,
                    size: mbi.RegionSize,
                    committed: mbi.State == MEM_COMMIT,
                    kind,
                    written: mbi.Protect & (PAGE_READWRITE | PAGE_EXECUTE_READWRITE) != 0,
                    guard: mbi.Protect & PAGE_GUARD != 0,
                });
            }
            match (mbi.BaseAddress as usize).checked_add(mbi.RegionSize) {
                Some(next) if next > addr => addr = next,
                _ => break,
            }
        }
        out
    }

    fn private_bytes() -> usize {
        // SAFETY: plain query into a correctly sized struct.
        unsafe {
            let mut c: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
            c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            if K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS, c.cb) == 0 {
                return 0;
            }
            c.PrivateUsage
        }
    }

    /// Committed bytes of every Windows heap in the process, and how many.
    fn heaps() -> (usize, usize) {
        // SAFETY: GetProcessHeaps fills at most `handles.len()` handles;
        // HeapSummary reads a heap's counters (it takes the heap's lock).
        unsafe {
            let mut handles = vec![std::ptr::null_mut(); 256];
            let n = GetProcessHeaps(handles.len() as u32, handles.as_mut_ptr()) as usize;
            let n = n.min(handles.len());
            let mut committed = 0usize;
            for &h in &handles[..n] {
                let mut s: HEAP_SUMMARY = std::mem::zeroed();
                s.cb = std::mem::size_of::<HEAP_SUMMARY>() as u32;
                if HeapSummary(h, 0, &mut s) != 0 {
                    committed += s.cbCommitted;
                }
            }
            (committed, n)
        }
    }

    fn module_name(base: usize) -> String {
        let mut buf = [0u16; 260];
        // SAFETY: an image's allocation base is its module handle.
        let n = unsafe { GetModuleFileNameW(base as _, buf.as_mut_ptr(), buf.len() as u32) } as usize;
        let path = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
        path.rsplit(['\\', '/']).next().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| format!("{base:#x}"))
    }
}

#[cfg(test)]
mod breakdown_tests {
    use super::{breakdown, Region, RegionKind};

    const MB: usize = 1_048_576;

    fn r(base: usize, size: usize, committed: bool, kind: RegionKind, written: bool, guard: bool) -> Region {
        Region { allocation_base: base, size, committed, kind, written, guard }
    }

    #[test]
    fn splits_private_bytes_by_owner() {
        let regions = [
            // A 32 MB allocation (a D3D12 descriptor heap, say), fully committed.
            r(0x1000_0000, 32 * MB, true, RegionKind::Private, false, false),
            // mimalloc's arena: 1 GB reserved, 20 MB committed.
            r(0x4000_0000, 20 * MB, true, RegionKind::Private, false, false),
            r(0x4000_0000, 1004 * MB, false, RegionKind::Private, false, false),
            // A thread stack: reserved 1 MB, 64 KB committed under a guard page.
            r(0x7000_0000, 960 * 1024, false, RegionKind::Private, false, false),
            r(0x7000_0000, 4096, true, RegionKind::Private, false, true),
            r(0x7000_0000, 60 * 1024, true, RegionKind::Private, false, false),
            // A DLL: 2 MB of code, 1 MB of written data.
            r(0x7ff0_0000, 2 * MB, true, RegionKind::Image, false, false),
            r(0x7ff0_0000, MB, true, RegionKind::Image, true, false),
            // A mapped file: never private.
            r(0x9000_0000, 50 * MB, true, RegionKind::Mapped, true, false),
        ];
        let m = breakdown(&regions, 60 * MB, (4 * MB, 3), Some(20.0), &|b| format!("dll@{b:x}"));
        assert_eq!(m.private_mb, 60.0);
        assert_eq!(m.threads, 1);
        assert_eq!(m.stacks_mb, 0.1);
        assert_eq!(m.image_written_mb, 1.0);
        assert_eq!(m.modules, vec![("dll@7ff00000".to_string(), 1.0)]);
        assert_eq!((m.win_heaps_mb, m.win_heaps), (4.0, 3));
        // 52 MB + stack committed, less 4 MB of heaps, the stack and 20 MB of mimalloc.
        assert_eq!(m.other_private_mb, 28.0);
        assert_eq!(m.top[0].committed_mb, 32.0);
        assert_eq!(m.top[1].reserved_mb, 1024.0);
        assert_eq!(m.top.len(), 2);
    }

    #[test]
    fn app_memory_reports_this_process() {
        let m = super::app_memory();
        eprintln!("{}", serde_json::to_string(&m).unwrap());
        assert!(m.private_mb > 0.0);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sums_root_and_descendants_only() {
        let mb = 1_048_576;
        let all = vec![
            (1, None, "other".to_string(), 999 * mb),
            (10, Some(1), "app".to_string(), 50 * mb),
            (11, Some(10), "browser".to_string(), 30 * mb),
            (12, Some(11), "renderer".to_string(), 200 * mb),
            (13, Some(1), "unrelated".to_string(), 70 * mb),
        ];
        let t = super::tree_of(10, &all);
        assert_eq!(t.total_mb, 280);
        assert_eq!(t.processes[0].name, "renderer");
        assert_eq!(t.processes.len(), 3);
    }
}

#[cfg(test)]
mod labels {
    #[test]
    fn names_chromium_roles() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(super::labelled("msedgewebview2.exe", &a(&["x.exe", "--type=gpu-process", "--foo"])), "msedgewebview2.exe (gpu-process)");
        assert_eq!(super::labelled("msedgewebview2.exe", &a(&["x.exe", "--type=renderer"])), "msedgewebview2.exe (renderer)");
        assert_eq!(
            super::labelled("msedgewebview2.exe", &a(&["x.exe", "--type=utility", "--utility-sub-type=network.mojom.NetworkService"])),
            "msedgewebview2.exe (NetworkService)"
        );
        assert_eq!(super::labelled("msedgewebview2.exe", &a(&["x.exe", "--embedded-browser-webview=1"])), "msedgewebview2.exe");
    }
}

#[cfg(test)]
mod live {
    #[test]
    fn current_tree_counts_this_process() {
        let t = super::current_tree();
        eprintln!("tree {} MB, {} procs", t.total_mb, t.processes.len());
        assert!(!t.processes.is_empty());
    }
}
