#!/usr/bin/env bash
# Cloud Run env resolution for deploy-app.sh.
#
# Order for every plain env var the deploy sends:
#   1. A variable that is set in the shell (including empty) — explicit override.
#   2. The value already on the service — a redeploy must not clobber it.
#   3. The default passed by the caller.
#
# Production defaults the caller should pass when the service has no value yet:
#   DEMO_AUTH_ENABLED=1
#   DEMO_AUTH_MAX_ROLE=author
#   GEMINI_MODEL=gemini-3.8-flash
#   GEMINI_LIVE_MODEL=gemini-3.8-live
#
# gemini-live-2.5-flash-native-audio is retired. Writing it over a live
# service, or onto a new service, is refused unless ALLOW_STALE_GEMINI_LIVE_MODEL=1.

# Read Cloud Run service JSON on stdin. Write name<TAB>value lines for plain
# env (secret refs have valueFrom and are skipped).
cloud_run_env_tsv() {
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      const data = JSON.parse(raw || "{}");
      const containers = (((data.spec || {}).template || {}).spec || {}).containers || [];
      const env = (containers[0] && containers[0].env) || [];
      for (const item of env) {
        if (!item || !item.name || !Object.prototype.hasOwnProperty.call(item, "value")) continue;
        const value = String(item.value).replace(/[\r\n\t]/g, " ");
        process.stdout.write(item.name + "\t" + value + "\n");
      }
    });
  '
}

resolve_deploy_env() {
  local key="$1"
  local default="$2"
  local existing="${3-}"
  if [[ -v $key ]]; then
    printf '%s' "${!key}"
    return 0
  fi
  if [[ -n "$existing" ]]; then
    printf '%s' "$existing"
    return 0
  fi
  printf '%s' "$default"
}

is_stale_gemini_live_model() {
  case "$1" in
    gemini-live-2.5-flash-native-audio) return 0 ;;
    *) return 1 ;;
  esac
}

# Prints the GEMINI_LIVE_MODEL to send. Warnings go to stderr.
guard_gemini_live_model() {
  local value="$1"
  local existing="${2-}"
  if ! is_stale_gemini_live_model "$value"; then
    printf '%s' "$value"
    return 0
  fi
  if [[ -n "$existing" ]] && ! is_stale_gemini_live_model "$existing"; then
    echo "deploy-app.sh: keeping GEMINI_LIVE_MODEL=${existing} (refusing stale ${value})." >&2
    printf '%s' "$existing"
    return 0
  fi
  if [[ "${ALLOW_STALE_GEMINI_LIVE_MODEL:-}" == "1" ]]; then
    echo "deploy-app.sh: ALLOW_STALE_GEMINI_LIVE_MODEL=1, writing ${value}." >&2
    printf '%s' "$value"
    return 0
  fi
  echo "deploy-app.sh: ${value} is retired. Using gemini-3.8-live. Set ALLOW_STALE_GEMINI_LIVE_MODEL=1 to force it." >&2
  printf '%s' "gemini-3.8-live"
}
