//! Memory of this app's whole process tree (the exe plus every WebView2 /
//! WebKit child: browser, renderer, GPU, utility), for the debug memory HUD
//! and the leak test. Working set (resident) per process, in MB.

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
    let all: Vec<(u32, Option<u32>, String, u64)> = sys
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
    tree_of(std::process::id(), &all)
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
