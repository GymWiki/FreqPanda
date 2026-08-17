// Prevents an extra console window from opening on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Clone, Serialize)]
struct TrainingProgress {
    bot_id: String,
    line: String,
}

// Every bot in this app runs FreqAI unconditionally, with a real ML model
// (e.g. LightGBMRegressor — see lib/strategy-presets.ts) — but the plain
// `freqtradeorg/freqtrade:stable` image is built from just requirements.txt,
// which does not include FreqAI's ML dependencies (scikit-learn, lightgbm).
// Those only ship in the `stable_freqai` tag (built from the separate
// requirements-freqai.txt). Must stay in sync with FREQTRADE_DOCKER_IMAGE
// in lib/hetzner.ts, the same fix applied there for cloud training/deploy.
const FREQTRADE_DOCKER_IMAGE: &str = "freqtradeorg/freqtrade:stable_freqai";

// Mode A (local training). Spawns FreqAI via `docker run` as a child
// process, streams its output to the frontend as `training-progress`
// events, and returns the path of the ONE resulting .joblib file — never a
// list. If training produces zero or more than one model file, this
// returns an error rather than guessing, mirroring the same strict
// single-file rule the upload API enforces.
//
// Deliberately does not touch the user's real exchange API credentials:
// downloading history and running `backtesting` (which is what actually
// trains and persists a FreqAI model — there is no separate "train"
// subcommand) only need public market data.
#[tauri::command]
async fn train_local_model(
    app: AppHandle,
    bot_id: String,
    strategy: String,
    strategy_code: String,
    exchange_name: String,
    auto_select_coins: bool,
    auto_select_pair_count: u32,
    pair_whitelist: String,
    force_retrain: bool,
) -> Result<String, String> {
    // `strategy` becomes a filename (user_data/strategies/<strategy>.py) —
    // reject anything that isn't a plain identifier before it's ever used
    // as a path, mirroring the same check the web API applies at creation
    // time (see lib/strategy-validation.ts).
    if !is_safe_python_identifier(&strategy) {
        return Err(format!("strategy must be a valid Python identifier (got: {strategy:?})"));
    }

    // Both the download-data loop below and the backtesting step after it
    // shell out to `docker run`. Get Docker into a ready state up front —
    // starting it automatically if it's already installed, or fetching and
    // opening the official installer if it isn't — instead of letting a
    // missing/stopped Docker surface as a confusing "historical data
    // download failed against every data source" error after the exchange
    // retry loop already ran. The user should only ever have to click Train.
    ensure_docker_ready(&app, &bot_id).await?;

    let download_container = training_container_name(&bot_id, "download");
    let backtest_container = training_container_name(&bot_id, "backtest");
    if force_retrain {
        emit_status(&app, &bot_id, "=== retrain requested: clearing this bot's previous local download/training run ===");
        for name in [&download_container, &backtest_container] {
            remove_container(name).await;
        }
    }

    let work_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?
        .join("freqtrade")
        .join(&bot_id);

    let user_data_dir = work_dir.join("user_data");
    let strategies_dir = user_data_dir.join("strategies");
    std::fs::create_dir_all(&strategies_dir).map_err(|e| format!("could not create strategies dir: {e}"))?;
    std::fs::write(strategies_dir.join(format!("{strategy}.py")), &strategy_code)
        .map_err(|e| format!("could not write strategy file: {e}"))?;

    // Mirrors buildPairlistConfig in lib/hetzner.ts: auto-select hands the
    // pair universe to freqtrade's own VolumePairList (top-N USDT markets by
    // 24h volume, N chosen by the user via the slider — see
    // AUTO_PAIRLIST_SIZE_RANGE in lib/hetzner.ts for the same clamp applied
    // here) instead of requiring the user to have typed a manual list.
    let clamped_pair_count = auto_select_pair_count.clamp(10, 200);
    // FreqAI's own JSON schema requires feature_parameters.include_corr_pairlist
    // (alongside include_timeframes) — must stay in sync with
    // DEFAULT_CORR_PAIRLIST in lib/hetzner.ts, the same fix applied there
    // after cloud training failed with "'include_corr_pairlist' is a
    // required property". BTC/USDT is the fixed platform-wide default.
    const CORR_PAIR: &str = "BTC/USDT";

    // The exchange(s) local training actually pulls candles from —
    // deliberately NOT `exchange_name` (the bot's own real trading
    // exchange, still accepted here for API compatibility with the
    // frontend invoke call but otherwise unused). This process never
    // touches real account credentials either way (see the module doc
    // above), so there was never a reason to tie the training data source
    // to whichever exchange the bot trades on. Must stay in sync with
    // DATA_SOURCE_EXCHANGE(S) in lib/hetzner.ts — same fix, same reason:
    // Bybit's own CloudFront distribution started hard-blocking EEA IPs as
    // part of its MiCA exit, breaking training for any Bybit-connected bot
    // regardless of anything in this codebase. Binance was ruled out too —
    // it failed to secure its own MiCA licence and began suspending EU
    // services around the same time. OKX (Malta MiCA licence) and Gate.io
    // (Malta CASP authorization) both confirmed still serving the EEA
    // normally, tried in that order below.
    const DATA_SOURCE_EXCHANGE: &str = "okx";
    const DATA_SOURCE_EXCHANGE_FALLBACK: &str = "gate";
    const DATA_SOURCE_EXCHANGES: [&str; 2] = [DATA_SOURCE_EXCHANGE, DATA_SOURCE_EXCHANGE_FALLBACK];
    let _ = &exchange_name;

    // static_download_pairs is Some(...) only for manual mode, where the
    // pairs to download are already a concrete list and don't depend on
    // which data source ends up succeeding. Auto-select mode instead
    // resolves a concrete list fresh per data-source attempt inside the
    // retry loop below, via resolve_auto_select_pairs — see that
    // function's own doc comment for why pair_whitelist_value staying a
    // ".*/USDT" wildcard here is fine (it's what freqtrade's VolumePairList
    // itself needs to expand against, for ongoing trade-time re-ranking)
    // even though the actual `download-data --pairs` argument must never
    // be that wildcard.
    let (pair_whitelist_value, pairlists_value, static_download_pairs) = if auto_select_coins {
        (
            serde_json::json!([".*/USDT"]),
            serde_json::json!([{
                "method": "VolumePairList",
                "number_assets": clamped_pair_count,
                "sort_key": "quoteVolume",
                "min_value": 0,
                "refresh_period": 1800,
            }]),
            None,
        )
    } else {
        let pairs: Vec<String> = pair_whitelist
            .split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        if pairs.is_empty() {
            return Err("pairWhitelist must contain at least one pair when auto-select is off".into());
        }
        // download-data needs BTC/USDT's own OHLCV history too — every
        // strategy preset implements feature_engineering_expand_all/_basic,
        // so FreqAI really does build correlation features from
        // include_corr_pairlist, but downloading only happens for
        // config["pairs"] (== exchange.pair_whitelist here), which is just
        // the user's own manually chosen trading pairs and has no reason to
        // include BTC/USDT. Passed via an explicit --pairs override below so
        // this never adds BTC/USDT to pair_whitelist/pairlists itself (i.e.
        // never makes the bot actually trade it unrequested) — just what
        // gets downloaded.
        let mut download_pairs = pairs.clone();
        if !download_pairs.iter().any(|p| p == CORR_PAIR) {
            download_pairs.push(CORR_PAIR.to_string());
        }
        (
            serde_json::json!(pairs),
            serde_json::json!([{ "method": "StaticPairList" }]),
            Some(download_pairs),
        )
    };

    let config = serde_json::json!({
        "stake_currency": "USDT",
        "stake_amount": "unlimited",
        "dry_run": true,
        "trading_mode": "spot",
        "exchange": {
            // Starting value only — rewritten before each download-data
            // attempt below, cycling through DATA_SOURCE_EXCHANGES if the
            // primary source fails.
            "name": DATA_SOURCE_EXCHANGE,
            "key": "",
            "secret": "",
            "pair_whitelist": pair_whitelist_value,
            "pair_blacklist": [],
        },
        "pairlists": pairlists_value,
        "freqai": {
            "enabled": true,
            "identifier": format!("{bot_id}-model"),
            "train_period_days": 30,
            "backtest_period_days": 7,
            "feature_parameters": { "include_timeframes": ["5m"], "include_corr_pairlist": [CORR_PAIR] },
            "data_split_parameters": { "test_size": 0.25 }
        }
    });

    // "--timeframes" (plural) is the only flag download-data actually
    // accepts — freqtrade's own ARGS_DOWNLOAD_DATA has no singular
    // "timeframe" entry, unlike backtesting below. Must stay in sync with
    // the same fix in lib/hetzner.ts.
    //
    // Tries each data source in order — config.json's exchange.name is
    // rewritten (never pair_whitelist/pairlists) before every attempt, so
    // this can never make the bot actually trade on whichever source it
    // happened to download candles from. Whichever config.json is left on
    // disk after this loop (the one from the successful attempt) is what
    // backtesting below actually trains against.
    let mut download_ok = false;
    let mut last_download_err = String::new();
    for data_source in DATA_SOURCE_EXCHANGES {
        emit_status(&app, &bot_id, format!("=== download-data: trying data source '{data_source}' ==="));
        let mut source_config = config.clone();
        source_config["exchange"]["name"] = serde_json::json!(data_source);
        let source_config_json = serde_json::to_vec_pretty(&source_config).map_err(|e| e.to_string())?;
        std::fs::write(user_data_dir.join("config.json"), source_config_json)
            .map_err(|e| format!("could not write config.json: {e}"))?;

        // Resolve the CONCRETE list of pairs to download. static_download_pairs
        // (manual mode) never depends on the data source; auto-select mode
        // resolves fresh per attempt via test-pairlist, since the whole
        // point is downloading exactly what VolumePairList would currently
        // rank top-N on *this* data source — never the ".*/USDT" wildcard
        // that config's own pair_whitelist uses for its own, separate
        // trade-time re-ranking (see resolve_auto_select_pairs).
        let download_data_pairs = match &static_download_pairs {
            Some(pairs) => pairs.clone(),
            None => match resolve_auto_select_pairs(&app, &bot_id, &work_dir, CORR_PAIR).await {
                Ok(pairs) => pairs,
                Err(e) => {
                    last_download_err = format!("could not resolve top-{clamped_pair_count} pairlist via test-pairlist: {e}");
                    continue;
                }
            },
        };
        emit_status(
            &app,
            &bot_id,
            format!(
                "=== about to download {} pairs (requested top {}): {} ===",
                download_data_pairs.len(),
                clamped_pair_count,
                download_data_pairs.join(", "),
            ),
        );

        let mut download_data_args: Vec<&str> =
            vec!["download-data", "--config", "user_data/config.json", "--timeframes", "5m", "--pairs"];
        download_data_args.extend(download_data_pairs.iter().map(|p| p.as_str()));
        match run_freqtrade_step_resumable(&app, &bot_id, &work_dir, &download_container, &download_data_args).await {
            Ok(()) => {
                download_ok = true;
                break;
            }
            Err(e) => last_download_err = e,
        }
    }
    if !download_ok {
        return Err(format!(
            "historical data download failed against every data source (tried: {}): {last_download_err}",
            DATA_SOURCE_EXCHANGES.join(", ")
        ));
    }

    run_freqtrade_step_resumable(
        &app,
        &bot_id,
        &work_dir,
        &backtest_container,
        &[
            "backtesting",
            "--config",
            "user_data/config.json",
            "--strategy",
            &strategy,
            "--freqaimodel",
            "LightGBMRegressor",
        ],
    )
    .await?;

    let models_dir = user_data_dir.join("models");
    let mut joblib_files = Vec::new();
    collect_joblib_files(&models_dir, &mut joblib_files)?;

    let result = match joblib_files.as_slice() {
        [single] => Ok(single.to_string_lossy().to_string()),
        [] => Err("training finished but produced no .joblib model file".into()),
        multiple => Err(format!(
            "expected exactly 1 .joblib model file, found {} — refusing to guess which one to upload",
            multiple.len()
        )),
    };
    // Both containers have done their job once a model's been collected —
    // remove them so a genuinely fresh future training run (a new bot, or
    // this one after force_retrain) never has to reason about stale state
    // left over from this one.
    if result.is_ok() {
        for name in [&download_container, &backtest_container] {
            remove_container(name).await;
        }
    }
    result
}

// Deliberately no in-memory "is this bot already training" guard here.
// The obvious version of one (a Mutex<HashSet<bot_id>> held for the
// duration of train_local_model) would actively break the page-refresh
// case this whole feature exists for: after a refresh, the *old* call is
// still running server-side (orphaned, but never cancelled — Tauri has no
// way to know its caller navigated away), so a naive guard would see the
// bot_id already present and reject the *new* call's reconnection attempt
// outright, right as BotCard.tsx's reconnect-on-mount effect tries to
// resubscribe to its progress events. Concurrency safety instead comes
// entirely from Docker's own atomic container naming (see
// run_freqtrade_step_resumable below): two calls racing into `docker run
// --name X` at the exact same moment can only ever have one succeed, and
// the loser gets a clean, ordinary error rather than a silent duplicate
// download — a narrow enough window (both calls have to hit that one
// instant with no container yet existing) that it isn't worth a lock that
// would otherwise misfire on every ordinary refresh.

// Stable per bot+step, so a later invocation — a page refresh, or this
// whole app being closed and reopened — can find and reattach to the same
// container Docker is still running (or has already finished), instead of
// blindly starting a second one. Only the two long-running, actually
// worth resuming steps get named containers (download, backtest);
// test-pairlist stays a plain `--rm` run, it's fast and stateless.
fn training_container_name(bot_id: &str, step: &str) -> String {
    format!("freqpanda-train-{bot_id}-{step}")
}

async fn remove_container(name: &str) {
    let mut cmd = Command::new("docker");
    cmd.args(["rm", "-f", name]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    hide_console_window(&mut cmd);
    let _ = cmd.output().await;
}

enum ContainerState {
    Missing,
    Running,
    ExitedOk,
    ExitedError,
}

async fn inspect_container(name: &str) -> ContainerState {
    let mut cmd = Command::new("docker");
    cmd.args(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", name])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    hide_console_window(&mut cmd);
    let output = match cmd.output().await {
        Ok(o) => o,
        Err(_) => return ContainerState::Missing,
    };
    // `docker inspect` exits non-zero when no container with this name
    // exists at all — the common case for a bot that's never been trained.
    if !output.status.success() {
        return ContainerState::Missing;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut parts = stdout.trim().split_whitespace();
    let running = parts.next() == Some("true");
    if running {
        return ContainerState::Running;
    }
    match parts.next().and_then(|s| s.parse::<i32>().ok()) {
        Some(0) => ContainerState::ExitedOk,
        _ => ContainerState::ExitedError,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalTrainingStatus {
    // "not_started" | "downloading" | "training" | "model_ready" — a plain
    // string rather than a Rust enum with #[serde(tag)] machinery, since
    // this crosses straight into a JS string-literal union
    // (components/BotCard.tsx) with nothing else consuming it on either
    // side that would benefit from more structure.
    state: String,
}

// Called from BotCard.tsx on mount (desktop only) — this is what lets a
// page refresh reconnect instead of showing a stale "not started" button:
// the frontend calls this first and only re-invokes train_local_model
// itself (which then reattaches rather than restarts, see
// run_freqtrade_step_resumable) when something is actually still in
// flight. Never spawns anything — purely reads existing Docker container
// state plus whatever's already on disk.
#[tauri::command]
async fn local_training_status(app: AppHandle, bot_id: String) -> Result<LocalTrainingStatus, String> {
    let work_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?
        .join("freqtrade")
        .join(&bot_id);

    let backtest_container = training_container_name(&bot_id, "backtest");
    match inspect_container(&backtest_container).await {
        ContainerState::Running => {
            return Ok(LocalTrainingStatus { state: "training".into() });
        }
        ContainerState::ExitedOk => {
            let models_dir = work_dir.join("user_data").join("models");
            let mut joblib_files = Vec::new();
            let _ = collect_joblib_files(&models_dir, &mut joblib_files);
            if !joblib_files.is_empty() {
                return Ok(LocalTrainingStatus { state: "model_ready".into() });
            }
        }
        ContainerState::Missing | ContainerState::ExitedError => {}
    }

    let download_container = training_container_name(&bot_id, "download");
    match inspect_container(&download_container).await {
        ContainerState::Running | ContainerState::ExitedOk => {
            return Ok(LocalTrainingStatus { state: "downloading".into() });
        }
        ContainerState::Missing | ContainerState::ExitedError => {}
    }

    Ok(LocalTrainingStatus { state: "not_started".into() })
}

fn is_safe_python_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else { return false };
    if value.len() > 64 || !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

enum DockerState {
    Ready,
    NotRunning,
    NotInstalled,
}

// docker.exe (and every `docker run`/`docker info` child process) is a
// Windows console-subsystem binary — spawning one from this GUI app
// without CREATE_NO_WINDOW pops up a visible cmd.exe-style console window
// on every invocation, even with stdout/stderr piped to null/captured:
// piping output doesn't suppress the console window itself on Windows,
// only CREATE_NO_WINDOW does. This app already streams that output into
// its own UI (see run_freqtrade_step_resumable's training-progress events), so the
// OS console window is never anything but confusing chrome. No-op on
// macOS, which has no equivalent console-window concept — applied to
// every Command in this file for consistency, including the two that
// spawn GUI apps (Docker Desktop, its installer) where it's a harmless
// no-op rather than a fix.
#[cfg(target_os = "windows")]
fn hide_console_window(cmd: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(target_os = "windows"))]
fn hide_console_window(_cmd: &mut Command) {}

// `docker run` itself (in run_freqtrade_step_resumable) can't tell these apart from
// its own io::Error alone in a way that's worth surfacing differently, but
// `docker info` can: NotFound means the binary isn't on PATH at all (Docker
// was never installed), anything else means it's installed but the daemon
// isn't answering (Docker Desktop isn't running).
async fn docker_state() -> DockerState {
    let mut cmd = Command::new("docker");
    cmd.arg("info")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    hide_console_window(&mut cmd);
    match cmd.status().await {
        Ok(status) if status.success() => DockerState::Ready,
        Ok(_) => DockerState::NotRunning,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DockerState::NotInstalled,
        // Some other spawn-level failure (permissions, etc.) — treat like
        // "not running" rather than misreporting Docker as never installed.
        Err(_) => DockerState::NotRunning,
    }
}

fn emit_status(app: &AppHandle, bot_id: &str, line: impl Into<String>) {
    let _ = app.emit(
        "training-progress",
        TrainingProgress { bot_id: bot_id.to_string(), line: line.into() },
    );
}

// The whole point of this function is that the user only ever has to click
// Train: if Docker is already installed but just isn't running, start it
// ourselves; if it isn't installed at all, fetch and open the official
// installer for them instead of sending them off to go find it. Either way
// this either returns Ok (Docker is ready, the caller can proceed) or an
// Err with a message explaining exactly what the user still needs to do —
// starting Docker Desktop or finishing its installer isn't something this
// app can script past; those are the vendor's own first-run/UAC/Gatekeeper
// prompts, not something we control.
async fn ensure_docker_ready(app: &AppHandle, bot_id: &str) -> Result<(), String> {
    match docker_state().await {
        DockerState::Ready => Ok(()),
        DockerState::NotRunning => {
            emit_status(app, bot_id, "=== Docker is installed but not running — starting it automatically ===");
            if let Err(e) = launch_installed_docker_desktop() {
                return Err(format!(
                    "Docker is installed but not running, and could not be started automatically ({e}). Start Docker Desktop yourself, then try training again."
                ));
            }
            emit_status(app, bot_id, "=== waiting for Docker Desktop to finish starting (this can take up to a minute) ===");
            if wait_for_docker(app, bot_id).await {
                Ok(())
            } else {
                Err("Docker Desktop was started but did not become ready in time. Wait for it to finish starting, then try training again.".into())
            }
        }
        DockerState::NotInstalled => {
            let url = docker_installer_url()?;
            let dest = std::env::temp_dir().join(docker_installer_filename());
            emit_status(app, bot_id, "=== Docker was not found — downloading the official installer ===");
            download_docker_installer(app, bot_id, url, &dest).await?;
            emit_status(app, bot_id, "=== opening the Docker Desktop installer ===");
            launch_downloaded_installer(&dest)?;
            Err("The Docker Desktop installer has been opened. Finish the installation (and start Docker Desktop once, the first time), then click Train again.".into())
        }
    }
}

// Docker Desktop's own startup (spinning up its VM backend) routinely takes
// 20-60s, so a single check right after asking the OS to launch it would
// almost always still see NotRunning — poll instead, with periodic status
// so the wait doesn't look frozen to the user.
async fn wait_for_docker(app: &AppHandle, bot_id: &str) -> bool {
    const MAX_ATTEMPTS: u32 = 45; // ~90s at 2s intervals
    for attempt in 0..MAX_ATTEMPTS {
        if matches!(docker_state().await, DockerState::Ready) {
            return true;
        }
        if attempt > 0 && attempt % 5 == 0 {
            emit_status(app, bot_id, "=== still waiting for Docker Desktop to start... ===");
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    false
}

// Docker Desktop's GUI app is a separate executable from the `docker` CLI
// on PATH, so having the CLI missing/unresponsive doesn't tell us where the
// GUI lives — these are the one place each platform's installer always
// puts it.
fn launch_installed_docker_desktop() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
        let exe = format!("{program_files}\\Docker\\Docker\\Docker Desktop.exe");
        if !std::path::Path::new(&exe).exists() {
            return Err("Docker Desktop.exe was not found at the expected install path".into());
        }
        let mut cmd = Command::new(exe);
        hide_console_window(&mut cmd);
        return cmd.spawn().map(|_| ()).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    {
        return Command::new("open").args(["-a", "Docker"]).spawn().map(|_| ()).map_err(|e| e.to_string());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("automatic Docker Desktop management is only supported on Windows and macOS".into())
    }
}

// Official, stable download URLs — same ones desktop.docker.com's own
// download buttons point at, just fetched directly instead of sending the
// user to go find them.
fn docker_installer_url() -> Result<&'static str, String> {
    #[cfg(target_os = "windows")]
    {
        return Ok("https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe");
    }
    #[cfg(target_os = "macos")]
    {
        return Ok(if cfg!(target_arch = "aarch64") {
            "https://desktop.docker.com/mac/main/arm64/Docker.dmg"
        } else {
            "https://desktop.docker.com/mac/main/amd64/Docker.dmg"
        });
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("automatic Docker installation is only supported on Windows and macOS".into())
    }
}

fn docker_installer_filename() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        return "DockerDesktopInstaller.exe";
    }
    #[cfg(target_os = "macos")]
    {
        return "DockerDesktop.dmg";
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "docker-installer"
    }
}

async fn download_docker_installer(
    app: &AppHandle,
    bot_id: &str,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    let mut resp = reqwest::get(url).await.map_err(|e| format!("could not reach {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("installer download failed with status {}", resp.status()));
    }
    let total = resp.content_length();
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("could not create {}: {e}", dest.display()))?;

    let mut downloaded: u64 = 0;
    let mut last_reported_pct: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if let Some(total) = total {
            let pct = downloaded.saturating_mul(100) / total.max(1);
            if pct >= last_reported_pct + 10 {
                last_reported_pct = pct;
                emit_status(app, bot_id, format!("=== downloading Docker Desktop installer: {pct}% ==="));
            }
        }
    }
    Ok(())
}

// Windows: the installer .exe runs directly and shows its own wizard
// (requesting UAC elevation itself — an OS security prompt this app can't
// and shouldn't try to suppress). macOS: `open` on a .dmg mounts it and
// shows Finder's normal drag-Docker.app-to-Applications prompt, the
// standard flow for any Mac app distributed this way.
fn launch_downloaded_installer(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new(path);
        hide_console_window(&mut cmd);
        return cmd.spawn().map(|_| ()).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    {
        return Command::new("open").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = path;
        Err("automatic Docker installation is only supported on Windows and macOS".into())
    }
}

// Auto-select's config.json carries a ".*/USDT" wildcard as pair_whitelist
// with a VolumePairList pairlists entry — freqtrade expands that live at
// trade/backtest time against whatever's currently top-N by volume, which
// is exactly the dynamic re-ranking auto-select is for. But `download-data
// --pairs .*/USDT` interprets that same wildcard as a *regex*, matching
// every USDT market the exchange lists — not the N the user actually
// chose. This resolves the wildcard to the same concrete list freqtrade's
// own VolumePairList would currently pick, via freqtrade's own
// `test-pairlist --print-json` (queries the exchange for live volume data,
// prints exactly the resolved pairs and nothing else to stdout — its own
// INFO/WARNING logging goes to stderr), the same mechanism this codebase's
// now-removed permanent data-server refresh script used for the identical
// problem. BTC/USDT is unioned in for downloading purposes only — every
// FreqAI preset needs it for correlation features (include_corr_pairlist)
// even on a run where it wouldn't otherwise rank in the top pairs by
// volume — this never adds it to the bot's actual trading whitelist,
// which stays whatever VolumePairList itself resolves at trade time.
async fn resolve_auto_select_pairs(
    app: &AppHandle,
    bot_id: &str,
    work_dir: &Path,
    corr_pair: &str,
) -> Result<Vec<String>, String> {
    emit_status(app, bot_id, "=== resolving the current top-N pairlist by volume (test-pairlist) ===");

    let mut cmd = Command::new("docker");
    cmd.args([
        "run",
        "--rm",
        "-v",
        &format!("{}:/freqtrade/user_data", work_dir.join("user_data").display()),
        FREQTRADE_DOCKER_IMAGE,
        "test-pairlist",
        "--config",
        "user_data/config.json",
        "--print-json",
    ])
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    hide_console_window(&mut cmd);

    let output = cmd.output().await.map_err(|e| format!("could not spawn docker: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("test-pairlist exited with {}: {}", output.status, stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut pairs: Vec<String> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("could not parse test-pairlist output as JSON ({e}): {}", stdout.trim()))?;
    if pairs.is_empty() {
        return Err("test-pairlist resolved an empty pairlist".into());
    }
    if !pairs.iter().any(|p| p == corr_pair) {
        pairs.push(corr_pair.to_string());
    }
    Ok(pairs)
}

// Streams a spawned child's stdout into training-progress events — the one
// piece both a fresh `docker run` and reattaching to an already-running
// container (via `docker logs -f`) need identically, so both call this
// instead of duplicating the read loop.
fn stream_stdout_as_progress(app: &AppHandle, bot_id: &str, stdout: tokio::process::ChildStdout) {
    let app = app.clone();
    let bot_id = bot_id.to_string();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit("training-progress", TrainingProgress { bot_id: bot_id.clone(), line });
        }
    });
}

// The resumable counterpart to a plain `docker run --rm`: named so a later
// call — a page refresh, or this whole app being closed and reopened —
// can find the same container instead of blindly starting a second one.
// Checks its state first: already succeeded means skip entirely (the step
// is done, nothing to do); still running means attach to its live output
// instead of starting a competing one; previously failed means clear it
// and start clean, since there's nothing useful to "resume" out of a
// failure. This is what makes train_local_model as a whole idempotent —
// calling it again for the same bot never redoes finished work.
async fn run_freqtrade_step_resumable(
    app: &AppHandle,
    bot_id: &str,
    work_dir: &Path,
    container_name: &str,
    args: &[&str],
) -> Result<(), String> {
    match inspect_container(container_name).await {
        ContainerState::ExitedOk => {
            emit_status(app, bot_id, format!("=== {container_name}: already completed in a previous run, skipping ==="));
            return Ok(());
        }
        ContainerState::Running => {
            emit_status(app, bot_id, format!("=== {container_name}: already running, reattaching to it ==="));
            return follow_and_wait(app, bot_id, container_name).await;
        }
        ContainerState::ExitedError => remove_container(container_name).await,
        ContainerState::Missing => {}
    }

    let mut docker_args = vec![
        "run".to_string(),
        "--name".to_string(),
        container_name.to_string(),
        "-v".to_string(),
        format!("{}:/freqtrade/user_data", work_dir.join("user_data").display()),
        FREQTRADE_DOCKER_IMAGE.to_string(),
    ];
    docker_args.extend(args.iter().map(|s| s.to_string()));

    let mut docker_cmd = Command::new("docker");
    docker_cmd
        .args(&docker_args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_console_window(&mut docker_cmd);
    let mut child = docker_cmd
        .spawn()
        .map_err(|e| format!("could not spawn docker (is Docker Desktop running?): {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        stream_stdout_as_progress(app, bot_id, stdout);
    }

    let status = child.wait().await.map_err(|e| format!("docker process error: {e}"))?;
    if !status.success() {
        return Err(format!("docker exited with status {status}"));
    }
    Ok(())
}

// Reattaches to a container this same function started on a previous
// invocation and that's still going: `docker logs -f` streams its output
// (from the beginning, same as a fresh run would show) and returns once
// the container stops producing output; `docker wait` then blocks (a
// no-op if it's already stopped) until it actually exits and hands back
// its real exit code, which is what a fresh run's own child.wait() above
// would have given us directly.
async fn follow_and_wait(app: &AppHandle, bot_id: &str, container_name: &str) -> Result<(), String> {
    let mut logs_cmd = Command::new("docker");
    logs_cmd
        .args(["logs", "-f", container_name])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    hide_console_window(&mut logs_cmd);
    let mut logs_child = logs_cmd
        .spawn()
        .map_err(|e| format!("could not attach to the already-running container: {e}"))?;
    if let Some(stdout) = logs_child.stdout.take() {
        stream_stdout_as_progress(app, bot_id, stdout);
    }
    let _ = logs_child.wait().await;

    let mut wait_cmd = Command::new("docker");
    wait_cmd.args(["wait", container_name]).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    hide_console_window(&mut wait_cmd);
    let output = wait_cmd.output().await.map_err(|e| format!("could not wait for container to finish: {e}"))?;
    let exit_code: i32 = String::from_utf8_lossy(&output.stdout).trim().parse().unwrap_or(-1);
    if exit_code != 0 {
        return Err(format!("docker exited with status {exit_code}"));
    }
    Ok(())
}

fn collect_joblib_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_joblib_files(&path, out)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("joblib") {
            out.push(path);
        }
    }
    Ok(())
}

// Runs once per launch, a few seconds after startup so the update check
// never competes with the window's own first paint. Only ever asks — never
// installs silently — an unattended restart mid-session would drop
// whatever the user was doing in the dashboard, and this app has no
// state of its own to preserve across that, just an open webview. The
// artifact itself is minisign-signed and verified by the updater plugin
// before install (see tauri.conf.json's plugins.updater.pubkey and the
// matching TAURI_SIGNING_PRIVATE_KEY secret in
// .github/workflows/release-desktop-app.yml) against whatever this repo's
// latest *published* GitHub Release currently is — draft releases (the
// default for every CI build, see that workflow) are invisible to it until
// a human publishes one.
async fn check_for_update(app: AppHandle) {
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    let update = match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => return,
            Err(e) => {
                eprintln!("[updater] check failed: {e}");
                return;
            }
        },
        Err(e) => {
            eprintln!("[updater] not available: {e}");
            return;
        }
    };

    let version = update.version.clone();
    let app_for_install = app.clone();
    app.dialog()
        .message(format!(
            "Er is een nieuwe versie beschikbaar ({version}). Nu downloaden en installeren? De app herstart daarna automatisch."
        ))
        .title("Update beschikbaar")
        .buttons(MessageDialogButtons::YesNo)
        .kind(MessageDialogKind::Info)
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            let app_for_install = app_for_install.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                    eprintln!("[updater] download/install failed: {e}");
                    return;
                }
                // request_restart() is a plain AppHandle method (tauri
                // core) — no separate process-plugin needed just for this.
                app_for_install.request_restart();
            });
        });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            tauri::async_runtime::spawn(check_for_update(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![train_local_model, local_training_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
