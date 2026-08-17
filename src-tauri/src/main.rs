// Prevents an extra console window from opening on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;
use tokio::io::{AsyncBufReadExt, BufReader};
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
    pair_whitelist: String,
) -> Result<String, String> {
    // `strategy` becomes a filename (user_data/strategies/<strategy>.py) —
    // reject anything that isn't a plain identifier before it's ever used
    // as a path, mirroring the same check the web API applies at creation
    // time (see lib/strategy-validation.ts).
    if !is_safe_python_identifier(&strategy) {
        return Err(format!("strategy must be a valid Python identifier (got: {strategy:?})"));
    }

    // Both the download-data loop below and the backtesting step after it
    // shell out to `docker run`. Check up front and fail with one
    // unambiguous message instead of letting a missing/stopped Docker
    // surface as a confusing "historical data download failed against
    // every data source" error after the exchange retry loop already ran.
    check_docker_available().await?;

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
    // pair universe to freqtrade's own VolumePairList (top-30 USDT markets
    // by 24h volume) instead of requiring the user to have typed a manual
    // list — local training should behave identically to cloud training,
    // not silently fall back to a stricter rule.
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

    let (pair_whitelist_value, pairlists_value, download_data_pairs) = if auto_select_coins {
        (
            serde_json::json!([".*/USDT"]),
            serde_json::json!([{
                "method": "VolumePairList",
                "number_assets": 30,
                "sort_key": "quoteVolume",
                "min_value": 0,
                "refresh_period": 1800,
            }]),
            vec![".*/USDT".to_string(), CORR_PAIR.to_string()],
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
            download_pairs,
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
        let _ = app.emit(
            "training-progress",
            TrainingProgress {
                bot_id: bot_id.clone(),
                line: format!("=== download-data: trying data source '{data_source}' ==="),
            },
        );
        let mut source_config = config.clone();
        source_config["exchange"]["name"] = serde_json::json!(data_source);
        let source_config_json = serde_json::to_vec_pretty(&source_config).map_err(|e| e.to_string())?;
        std::fs::write(user_data_dir.join("config.json"), source_config_json)
            .map_err(|e| format!("could not write config.json: {e}"))?;

        let mut download_data_args: Vec<&str> =
            vec!["download-data", "--config", "user_data/config.json", "--timeframes", "5m", "--pairs"];
        download_data_args.extend(download_data_pairs.iter().map(|p| p.as_str()));
        match run_freqtrade_step(&app, &bot_id, &work_dir, &download_data_args).await {
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

    run_freqtrade_step(
        &app,
        &bot_id,
        &work_dir,
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

    match joblib_files.as_slice() {
        [single] => Ok(single.to_string_lossy().to_string()),
        [] => Err("training finished but produced no .joblib model file".into()),
        multiple => Err(format!(
            "expected exactly 1 .joblib model file, found {} — refusing to guess which one to upload",
            multiple.len()
        )),
    }
}

fn is_safe_python_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else { return false };
    if value.len() > 64 || !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// `docker run` itself (in run_freqtrade_step) can't tell these two failure
// modes apart from its own io::Error alone in a way that's worth surfacing
// differently, but `docker info` can: NotFound means the binary isn't on
// PATH at all (Docker was never installed), anything else means it's
// installed but the daemon isn't answering (Docker Desktop isn't running).
async fn check_docker_available() -> Result<(), String> {
    match Command::new("docker")
        .arg("info")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
    {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err(
            "Docker is installed but not running. Start Docker Desktop, then try training again.".into(),
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(
            "Docker was not found. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) and start it before training locally.".into(),
        ),
        Err(e) => Err(format!("could not check Docker status: {e}")),
    }
}

async fn run_freqtrade_step(app: &AppHandle, bot_id: &str, work_dir: &Path, args: &[&str]) -> Result<(), String> {
    let mut docker_args = vec![
        "run".to_string(),
        "--rm".to_string(),
        "-v".to_string(),
        format!("{}:/freqtrade/user_data", work_dir.join("user_data").display()),
        FREQTRADE_DOCKER_IMAGE.to_string(),
    ];
    docker_args.extend(args.iter().map(|s| s.to_string()));

    let mut child = Command::new("docker")
        .args(&docker_args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not spawn docker (is Docker Desktop running?): {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        let bot_id = bot_id.to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "training-progress",
                    TrainingProgress { bot_id: bot_id.clone(), line },
                );
            }
        });
    }

    let status = child.wait().await.map_err(|e| format!("docker process error: {e}"))?;
    if !status.success() {
        return Err(format!("docker exited with status {status}"));
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
        .invoke_handler(tauri::generate_handler![train_local_model])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
