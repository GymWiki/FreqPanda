// Prevents an extra console window from opening on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};

use chrono::{Duration, Utc};
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
    // here) instead of requiring the user to have typed a manual list. This
    // file's own config.json, though, NEVER declares VolumePairList — see
    // build_local_training_config's doc comment (checklist item 1) for why.
    // Auto-select here just means resolving a concrete top-N list, fresh
    // per data-source attempt below (ranking can differ per exchange), via
    // resolve_auto_select_pairs.
    let clamped_pair_count = auto_select_pair_count.clamp(10, 200);
    const CORR_PAIR: &str = "BTC/USDT";
    const BASE_TIMEFRAME: &str = "5m";

    // FreqAI backtesting (which is what actually trains a model — see the
    // module doc above) refuses to start without an explicit --timerange:
    // "Please pass --timerange if you intend to use FreqAI for
    // backtesting." The window has to be wide enough to fit several full
    // train+backtest cycles or FreqAI has nothing meaningful to slide
    // across — same 90-day floor / 4x-of-(train+backtest) multiplier this
    // project already used for cloud training before local training
    // replaced it (see buildFreqAITrainingCloudInit's git history in
    // lib/hetzner.ts). Also drives download-data below with the exact same
    // range, so the candles on disk always cover what backtesting asks for
    // — never narrower (which FreqAI would reject) or pointlessly wider.
    const FREQAI_TRAIN_PERIOD_DAYS: i64 = 30;
    const FREQAI_BACKTEST_PERIOD_DAYS: i64 = 7;
    let timerange_days = ((FREQAI_TRAIN_PERIOD_DAYS + FREQAI_BACKTEST_PERIOD_DAYS) * 4).max(90);
    let today = Utc::now().date_naive();
    let start_date = today - Duration::days(timerange_days);
    let fmt_date = |d: chrono::NaiveDate| d.format("%Y%m%d").to_string();
    let timerange = format!("{}-{}", fmt_date(start_date), fmt_date(today));

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

    // manual_pairs is Some(...) only for manual mode, where the *trading*
    // pairs (never including CORR_PAIR — see the download-pairs union
    // below) are already a concrete list the user typed, identical across
    // every data-source attempt. None for auto-select, which resolves a
    // concrete list fresh per attempt inside the retry loop below (see
    // resolve_auto_select_pairs) — never a wildcard, ever, anywhere in
    // this function; see build_local_training_config's doc comment.
    let manual_pairs: Option<Vec<String>> = if auto_select_coins {
        None
    } else {
        let pairs: Vec<String> = pair_whitelist
            .split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        if pairs.is_empty() {
            return Err("pairWhitelist must contain at least one pair when auto-select is off".into());
        }
        Some(pairs)
    };

    // Concrete top-N pairlist enforcement only actually happens the moment
    // a download genuinely runs. run_freqtrade_step_resumable's
    // container-name resumability keys purely on bot_id+step, so on its
    // own it can't tell "this bot's download already finished — for this
    // same request" apart from "already finished, for a DIFFERENT top-N
    // count or manual pairlist picked after that". Without this check,
    // moving the pair-count slider (or editing the manual list) and
    // clicking Train again would silently reattach/skip into the
    // *previous* selection's container forever — the exact regression
    // this comment is guarding against. download_identity captures what
    // download-data is actually being asked to fetch this call; comparing
    // it against the marker written after the last successful download
    // (below) is what makes that enforcement hold on a resumed/reattached
    // run too, not just a bot's very first training run.
    let download_identity = compute_download_identity(&manual_pairs, clamped_pair_count, &timerange);
    let download_identity_path = user_data_dir.join(".download-identity");
    let previous_download_identity = std::fs::read_to_string(&download_identity_path).ok();
    if previous_download_identity.as_deref() != Some(download_identity.as_str()) {
        emit_status(
            &app,
            &bot_id,
            "=== pairlist selection (or timerange) changed since the last local training run — discarding the previous download ===",
        );
        remove_container(&download_container).await;
    }

    // "--timeframes" (plural) is the only flag download-data actually
    // accepts — freqtrade's own ARGS_DOWNLOAD_DATA has no singular
    // "timeframe" entry, unlike backtesting below. Must stay in sync with
    // the same fix in lib/hetzner.ts.
    //
    // Tries each data source in order. Every attempt resolves its own
    // trading_pairs, builds the FULL config via build_local_training_config
    // (never a partial rewrite of a previously-written config — see that
    // function's own doc comment for the whole checklist this enforces),
    // validates it, and only then writes it to disk — so config.json is
    // NEVER in a state download-data or backtesting could run against
    // except this one, fully-checked shape. Whichever attempt's config.json
    // is left on disk after this loop (the one that actually downloaded
    // successfully) is what backtesting below trains against, built from
    // the exact same trading_pairs value that attempt's download used —
    // see the download_pairs union just below for why that pairing can
    // never drift apart.
    let mut download_ok = false;
    let mut last_download_err = String::new();
    for data_source in DATA_SOURCE_EXCHANGES {
        emit_status(&app, &bot_id, format!("=== download-data: trying data source '{data_source}' ==="));

        // The CONCRETE list of pairs this bot will actually trade/backtest
        // — never a wildcard, never resolved via a config that declares
        // VolumePairList (see build_local_training_config's checklist item
        // 1). manual_pairs never depends on the data source; auto-select
        // resolves fresh per attempt, since the whole point is matching
        // exactly what VolumePairList would currently rank top-N on *this*
        // data source.
        let trading_pairs = match &manual_pairs {
            Some(pairs) => pairs.clone(),
            None => match resolve_auto_select_pairs(&app, &bot_id, &work_dir, data_source, clamped_pair_count).await {
                Ok(pairs) => pairs,
                Err(e) => {
                    last_download_err = format!("could not resolve top-{clamped_pair_count} pairlist via test-pairlist: {e}");
                    continue;
                }
            },
        };

        // download-data needs CORR_PAIR's own OHLCV history too — every
        // strategy preset implements feature_engineering_expand_all/_basic,
        // so FreqAI really does build correlation features from
        // include_corr_pairlist, but downloading only happens for whatever
        // --pairs lists explicitly. Unioned in for downloading purposes
        // only: config.json's own pair_whitelist (below) stays exactly
        // trading_pairs, so this never makes the bot actually trade
        // CORR_PAIR unrequested — FreqAI reads its candles separately, via
        // include_corr_pairlist, not through the main whitelist.
        let mut download_pairs = trading_pairs.clone();
        if !download_pairs.iter().any(|p| p == CORR_PAIR) {
            download_pairs.push(CORR_PAIR.to_string());
        }

        let config = build_local_training_config(&LocalTrainingConfigParams {
            bot_id: &bot_id,
            data_source,
            pair_whitelist: &trading_pairs,
            corr_pair: CORR_PAIR,
            base_timeframe: BASE_TIMEFRAME,
            train_period_days: FREQAI_TRAIN_PERIOD_DAYS,
            backtest_period_days: FREQAI_BACKTEST_PERIOD_DAYS,
        });
        validate_local_training_config(&config, &timerange, BASE_TIMEFRAME)?;
        let config_json = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
        std::fs::write(user_data_dir.join("config.json"), config_json)
            .map_err(|e| format!("could not write config.json: {e}"))?;

        emit_status(
            &app,
            &bot_id,
            format!(
                "=== about to download {} pairs (requested top {}): {} ===",
                download_pairs.len(),
                clamped_pair_count,
                download_pairs.join(", "),
            ),
        );

        let mut download_data_args: Vec<&str> = vec![
            "download-data",
            "--config",
            "user_data/config.json",
            "--timeframes",
            BASE_TIMEFRAME,
            "--timerange",
            &timerange,
            "--pairs",
        ];
        download_data_args.extend(download_pairs.iter().map(|p| p.as_str()));
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
    // Record what actually got downloaded this time, so the *next* call
    // (fresh, resumed, or reattached) can tell whether it's still the same
    // request — see download_identity's own comment above for why this
    // matters. Best-effort: a failure to persist it just means the next
    // run treats this one as stale and redownloads, never the reverse.
    let _ = std::fs::write(&download_identity_path, &download_identity);

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
            "--timerange",
            &timerange,
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

// ============================================================================
// THE central freqtrade config.json generator for LOCAL TRAINING.
//
// This app generates a freqtrade config.json from two independent places —
// this file (Rust, for local Tauri training/backtesting) and
// lib/hetzner.ts (TypeScript, for VPS live/paper-trading deploy) — because
// the two run in genuinely different languages/processes; there is no way
// to share one literal generator between them. Within THIS file, though,
// there is exactly one: every call site that needs a config.json for
// local training calls build_local_training_config below — nothing else
// in this file constructs one by hand. That single-generator rule is what
// makes the checklist below actually enforceable: validate_local_training_
// config runs on every config this function's caller builds, so a future
// edit can't silently drop a requirement without a build-time... no, a
// *run*-time failure, immediately, before Docker is ever spawned.
//
// This checklist exists because freqtrade requirements kept surfacing here
// one at a time, each independently discovered by hitting a crash first:
// wrong/missing pairlist, missing entry_pricing/exit_pricing, and finally
// four MORE missing feature_parameters keys, all found the same way —
// KeyError: 'indicator_periods_candles' from freqtrade/data/dataprovider.py's
// get_required_startup(). That last one prompted an actual audit instead of
// another one-field patch: freqtrade's own docs/freqai-parameter-table.md
// "Required" column turned out to be an unreliable source (it doesn't mark
// indicator_periods_candles required at all, despite the crash) — the only
// way to know for certain whether a field is a hard requirement is whether
// freqtrade's own Python does a raw `dict[...]` subscript on it somewhere
// with no `.get(..., default)` fallback. So this checklist is built from a
// direct read of freqtrade's `stable` branch source (dataprovider.py's
// get_required_startup, freqai/data_kitchen.py, freqai/freqai_interface.py)
// for every such raw access on freqai/feature_parameters keys, cross-checked
// against freqtrade's own config_examples/config_freqai.example.json for
// sensible default values — not just the parameter-table docs, which this
// investigation showed can't be trusted alone. Every requirement found is
// now both baked into this function AND checked by
// validate_local_training_config:
//
//   1. PAIRLIST — must be a concrete StaticPairList with a real pair list,
//      NEVER VolumePairList and NEVER a ".*/USDT" wildcard. freqtrade's
//      Pairlist Handlers explicitly refuse VolumePairList under
//      backtesting ("Pairlist Handlers VolumePairList do not support
//      backtesting") — it's a live-market-data pairlist, backtesting needs
//      a pre-known fixed list. Callers MUST resolve a concrete list
//      themselves before calling this function (see
//      resolve_auto_select_pairs for the auto-select case, which uses
//      VolumePairList only in a throwaway probe config that never reaches
//      this function or Docker) — this function only accepts already-
//      concrete pairs via `params.pair_whitelist`, it never resolves them.
//   2. entry_pricing / exit_pricing — freqtrade's Exchange.validate_config
//      does a raw `config["exit_pricing"]`/`config["entry_pricing"]` dict
//      subscript with no schema default, so a missing key crashes with a
//      bare KeyError rather than a readable validation error.
//   3. freqai.feature_parameters.include_corr_pairlist /
//      include_timeframes — required by FreqAI's own JSON schema whenever
//      freqai.enabled is true (raw-accessed via .get() with no default in
//      freqai/data_kitchen.py, so a missing value surfaces later as a
//      confusing None/empty-list failure rather than a clean error here).
//   4. freqai.feature_parameters.indicator_periods_candles — raw
//      `feature_parameters["indicator_periods_candles"]` subscript in
//      dataprovider.py's get_required_startup(). THE crash that triggered
//      this whole audit. Default [10, 20] — freqtrade's own example config.
//   5. freqai.feature_parameters.include_shifted_candles — raw subscript
//      in data_kitchen.py's feature-shifting loop. Default 2 — freqtrade's
//      own example config.
//   6. freqai.feature_parameters.buffer_train_data_candles — raw subscript
//      in data_kitchen.py. Default 0 — freqtrade's own documented default.
//   7. freqai.feature_parameters.shuffle_after_split — raw subscript
//      (`feat_dict["shuffle_after_split"]`, where feat_dict IS
//      feature_parameters directly, not a copy with merged defaults) in
//      data_kitchen.py's make_train_test_datasets(). Default false —
//      freqtrade's own documented default, and the behaviorally correct
//      one for time-series data regardless (don't shuffle train/test
//      chronological order).
//   8. --timerange (a CLI arg passed to download-data/backtesting, not
//      part of this JSON, but validated alongside it — see
//      validate_local_training_config) — FreqAI backtesting refuses to
//      run without one.
//
// Deliberately NOT added, despite appearing in freqtrade's example config:
// DI_threshold, weight_factor, principal_component_analysis,
// use_SVM_to_remove_outliers, use_DBSCAN_to_remove_outliers, svm_params,
// plot_feature_importances, reverse_train_test_order, label_period_candles.
// Every one of these is accessed via `.get(key, some_default)` in
// freqtrade's own source (confirmed in the same audit) — omitting them
// changes nothing but which documented default applies, so adding them
// would just be silently opinionated tuning dressed up as a required-field
// fix. label_period_candles specifically: this app's generated strategies
// (lib/strategy-presets.ts's set_freqai_targets) hardcode their own
// look-ahead via `.shift(-N)` and never read this config key at all.
//
// Keep this in sync with whatever lib/hetzner.ts's own required-field
// comments (PRICE_DISCOVERY_CONFIG, DEFAULT_MAX_OPEN_TRADES, buildPairlistConfig,
// and the freqai schema comment near include_corr_pairlist) document as
// required there — that file cross-references back here for the same
// reason.
struct LocalTrainingConfigParams<'a> {
    bot_id: &'a str,
    data_source: &'a str,
    /// Requirement 1: MUST already be concrete — never a wildcard/regex,
    /// never sourced from a config that declared VolumePairList.
    pair_whitelist: &'a [String],
    corr_pair: &'a str,
    base_timeframe: &'a str,
    train_period_days: i64,
    backtest_period_days: i64,
}

fn build_local_training_config(params: &LocalTrainingConfigParams) -> serde_json::Value {
    serde_json::json!({
        "stake_currency": "USDT",
        "stake_amount": "unlimited",
        "dry_run": true,
        "trading_mode": "spot",
        // freqtrade's SCHEMA_TRADE_REQUIRED lists this as required, with
        // no schema-level default — see lib/hetzner.ts's
        // DEFAULT_MAX_OPEN_TRADES, kept in sync.
        "max_open_trades": 5,
        "exchange": {
            "name": params.data_source,
            "key": "",
            "secret": "",
            // ===== Requirement 1: PAIRLIST =====
            // Concrete list only — see this function's own doc comment.
            "pair_whitelist": params.pair_whitelist,
            "pair_blacklist": [],
        },
        // ===== Requirement 1: PAIRLIST (continued) =====
        // StaticPairList, always — never VolumePairList, which freqtrade
        // itself refuses under backtesting.
        "pairlists": [{ "method": "StaticPairList" }],
        // ===== Requirement 2: entry_pricing / exit_pricing =====
        "entry_pricing": { "price_side": "same", "use_order_book": true, "order_book_top": 1 },
        "exit_pricing": { "price_side": "same", "use_order_book": true, "order_book_top": 1 },
        "freqai": {
            "enabled": true,
            "identifier": format!("{}-model", params.bot_id),
            "train_period_days": params.train_period_days,
            "backtest_period_days": params.backtest_period_days,
            "feature_parameters": {
                // ===== Requirement 3: include_timeframes / include_corr_pairlist =====
                "include_timeframes": [params.base_timeframe],
                "include_corr_pairlist": [params.corr_pair],
                // ===== Requirement 4: indicator_periods_candles =====
                "indicator_periods_candles": [10, 20],
                // ===== Requirement 5: include_shifted_candles =====
                "include_shifted_candles": 2,
                // ===== Requirement 6: buffer_train_data_candles =====
                "buffer_train_data_candles": 0,
                // ===== Requirement 7: shuffle_after_split =====
                "shuffle_after_split": false,
            },
            "data_split_parameters": { "test_size": 0.25 }
        }
    })
}

// Self-validation for every config build_local_training_config produces —
// see that function's own doc comment for the full checklist and why this
// exists. Called on every attempt, right after building the config and
// before it's ever written to disk or handed to Docker, so a violation is
// a clear Rust-level error instead of a cryptic Python crash (or, worse,
// a silent wrong-pairlist run) deep in a container's logs. timerange and
// download_timeframe are passed alongside config because requirement 4
// (--timerange) is a CLI arg, not a JSON field, and the timeframe
// consistency check needs to compare against what download-data was
// actually told to fetch.
fn validate_local_training_config(config: &serde_json::Value, timerange: &str, download_timeframe: &str) -> Result<(), String> {
    const REQUIRED_TOP_LEVEL_KEYS: &[&str] = &[
        "stake_currency",
        "stake_amount",
        "dry_run",
        "trading_mode",
        "max_open_trades",
        "exchange",
        "pairlists",
        "entry_pricing",
        "exit_pricing",
        "freqai",
    ];
    for key in REQUIRED_TOP_LEVEL_KEYS {
        if config.get(key).is_none() {
            return Err(format!(
                "generated config.json is missing required key '{key}' — this is a bug in build_local_training_config, not a Docker/network problem"
            ));
        }
    }

    // ===== Requirement 1: PAIRLIST =====
    let pairlist_method = config.get("pairlists").and_then(|p| p.get(0)).and_then(|p| p.get("method")).and_then(|m| m.as_str());
    if pairlist_method != Some("StaticPairList") {
        return Err(format!(
            "generated config.json's pairlists[0].method is {pairlist_method:?}, expected \"StaticPairList\" — freqtrade's Pairlist Handlers do not support VolumePairList under backtesting"
        ));
    }
    let pair_whitelist = config.get("exchange").and_then(|e| e.get("pair_whitelist")).and_then(|w| w.as_array());
    match pair_whitelist {
        None => return Err("generated config.json is missing exchange.pair_whitelist".into()),
        Some(pairs) if pairs.is_empty() => {
            return Err("generated config.json's exchange.pair_whitelist is empty — StaticPairList needs at least 1 concrete pair".into());
        }
        Some(pairs) => {
            for pair in pairs {
                let pair_str = pair.as_str().unwrap_or("");
                if pair_str.is_empty() || pair_str.contains('*') || !pair_str.contains('/') {
                    return Err(format!(
                        "generated config.json's exchange.pair_whitelist contains {pair:?}, which isn't a concrete \"BASE/QUOTE\" pair — looks like a wildcard/regex leaked in"
                    ));
                }
            }
        }
    }

    // ===== Requirement 2: entry_pricing / exit_pricing =====
    for pricing_key in ["entry_pricing", "exit_pricing"] {
        let pricing_value = config.get(pricing_key);
        if !matches!(pricing_value, Some(v) if v.is_object()) {
            return Err(format!("generated config.json's '{pricing_key}' is missing or not an object"));
        }
        if pricing_value.and_then(|v| v.get("price_side")).is_none() {
            return Err(format!("generated config.json's '{pricing_key}' is missing 'price_side'"));
        }
    }

    let feature_parameters = config.get("freqai").and_then(|f| f.get("feature_parameters"));

    // ===== Requirement 3: include_corr_pairlist =====
    if feature_parameters.and_then(|f| f.get("include_corr_pairlist")).is_none() {
        return Err("generated config.json is missing freqai.feature_parameters.include_corr_pairlist".into());
    }

    // ===== Requirement 3 (continued): timeframes consistent with what's downloaded =====
    let declares_download_timeframe = feature_parameters
        .and_then(|f| f.get("include_timeframes"))
        .and_then(|v| v.as_array())
        .is_some_and(|timeframes| timeframes.iter().any(|t| t.as_str() == Some(download_timeframe)));
    if !declares_download_timeframe {
        return Err(format!(
            "generated config.json's freqai.feature_parameters.include_timeframes does not include '{download_timeframe}', the timeframe download-data is actually told to fetch"
        ));
    }

    // ===== Requirement 4: indicator_periods_candles =====
    // Raw `feature_parameters["indicator_periods_candles"]` subscript in
    // freqtrade/data/dataprovider.py's get_required_startup() — a missing
    // key here is a bare Python KeyError, not a schema validation message.
    let has_indicator_periods = feature_parameters
        .and_then(|f| f.get("indicator_periods_candles"))
        .and_then(|v| v.as_array())
        .is_some_and(|periods| !periods.is_empty() && periods.iter().all(|p| p.as_u64().is_some()));
    if !has_indicator_periods {
        return Err(
            "generated config.json's freqai.feature_parameters.indicator_periods_candles is missing, empty, or not a list of positive integers".into(),
        );
    }

    // ===== Requirement 5: include_shifted_candles =====
    if feature_parameters.and_then(|f| f.get("include_shifted_candles")).and_then(|v| v.as_u64()).is_none() {
        return Err("generated config.json's freqai.feature_parameters.include_shifted_candles is missing or not a non-negative integer".into());
    }

    // ===== Requirement 6: buffer_train_data_candles =====
    if feature_parameters.and_then(|f| f.get("buffer_train_data_candles")).and_then(|v| v.as_u64()).is_none() {
        return Err("generated config.json's freqai.feature_parameters.buffer_train_data_candles is missing or not a non-negative integer".into());
    }

    // ===== Requirement 7: shuffle_after_split =====
    if feature_parameters.and_then(|f| f.get("shuffle_after_split")).and_then(|v| v.as_bool()).is_none() {
        return Err("generated config.json's freqai.feature_parameters.shuffle_after_split is missing or not a boolean".into());
    }

    // ===== Requirement 8: --timerange =====
    if timerange.trim().is_empty() {
        return Err("timerange must not be empty — FreqAI backtesting refuses to run without --timerange".into());
    }

    Ok(())
}

#[cfg(test)]
mod local_training_config_tests {
    use super::{build_local_training_config, validate_local_training_config, LocalTrainingConfigParams};

    const VALID_TIMERANGE: &str = "20260101-20260601";
    const VALID_TIMEFRAME: &str = "5m";

    fn valid_config() -> serde_json::Value {
        build_local_training_config(&LocalTrainingConfigParams {
            bot_id: "bot-1",
            data_source: "okx",
            pair_whitelist: &["BTC/USDT".to_string(), "ETH/USDT".to_string()],
            corr_pair: "BTC/USDT",
            base_timeframe: VALID_TIMEFRAME,
            train_period_days: 30,
            backtest_period_days: 7,
        })
    }

    #[test]
    fn build_local_training_config_passes_its_own_validation() {
        // The actual generator, exercised end-to-end against its own
        // validator — the strongest guarantee this checklist stays true:
        // if a future edit to build_local_training_config drops a
        // required field, THIS test fails, not just a hand-written fixture.
        assert!(validate_local_training_config(&valid_config(), VALID_TIMERANGE, VALID_TIMEFRAME).is_ok());
    }

    #[test]
    fn rejects_volume_pair_list() {
        // Regression coverage for the actual bug this validator exists to
        // catch: freqtrade flatly refuses VolumePairList under
        // backtesting ("Pairlist Handlers VolumePairList do not support
        // backtesting") — this must never reach `docker run` again.
        let mut config = valid_config();
        config["pairlists"] = serde_json::json!([{ "method": "VolumePairList", "number_assets": 20 }]);
        let err = validate_local_training_config(&config, VALID_TIMERANGE, VALID_TIMEFRAME).unwrap_err();
        assert!(err.contains("VolumePairList") || err.contains("StaticPairList"), "error should name the pairlist problem, got: {err}");
    }

    #[test]
    fn rejects_a_wildcard_pair_whitelist() {
        let mut config = valid_config();
        config["exchange"]["pair_whitelist"] = serde_json::json!([".*/USDT"]);
        let err = validate_local_training_config(&config, VALID_TIMERANGE, VALID_TIMEFRAME).unwrap_err();
        assert!(err.contains("pair_whitelist"), "error should name the field, got: {err}");
    }

    #[test]
    fn rejects_an_empty_pair_whitelist() {
        let mut config = valid_config();
        config["exchange"]["pair_whitelist"] = serde_json::json!([]);
        assert!(validate_local_training_config(&config, VALID_TIMERANGE, VALID_TIMEFRAME).is_err());
    }

    #[test]
    fn rejects_a_config_missing_exit_pricing() {
        let mut config = valid_config();
        config.as_object_mut().unwrap().remove("exit_pricing");
        let err = validate_local_training_config(&config, VALID_TIMERANGE, VALID_TIMEFRAME).unwrap_err();
        assert!(err.contains("exit_pricing"), "error should name the missing key, got: {err}");
    }

    #[test]
    fn rejects_a_config_missing_entry_pricing() {
        let mut config = valid_config();
        config.as_object_mut().unwrap().remove("entry_pricing");
        assert!(validate_local_training_config(&config, VALID_TIMERANGE, VALID_TIMEFRAME).is_err());
    }

    #[test]
    fn rejects_a_config_missing_max_open_trades() {
        let mut config = valid_config();
        config.as_object_mut().unwrap().remove("max_open_trades");
        assert!(validate_local_training_config(&config, VALID_TIMERANGE, VALID_TIMEFRAME).is_err());
    }

    #[test]
    fn rejects_a_config_missing_include_corr_pairlist() {
        let mut config = valid_config();
        config["freqai"]["feature_parameters"].as_object_mut().unwrap().remove("include_corr_pairlist");
        let err = validate_local_training_config(&config, VALID_TIMERANGE, VALID_TIMEFRAME).unwrap_err();
        assert!(err.contains("include_corr_pairlist"), "error should name the missing key, got: {err}");
    }

    #[test]
    fn rejects_an_empty_timerange() {
        let err = validate_local_training_config(&valid_config(), "", VALID_TIMEFRAME).unwrap_err();
        assert!(err.contains("timerange"), "error should name timerange, got: {err}");
    }

    #[test]
    fn rejects_a_timeframe_not_downloaded() {
        // The config declares "5m" but download-data was (hypothetically)
        // told to fetch "1h" instead — these must never disagree.
        let err = validate_local_training_config(&valid_config(), VALID_TIMERANGE, "1h").unwrap_err();
        assert!(err.contains("include_timeframes"), "error should name the field, got: {err}");
    }

    #[test]
    fn rejects_a_config_missing_indicator_periods_candles() {
        // Regression coverage for the actual bug that triggered this whole
        // audit: freqtrade's dataprovider.py crashes with a raw
        // `KeyError: 'indicator_periods_candles'` — must never reach
        // `docker run` again.
        let mut config = valid_config();
        config["freqai"]["feature_parameters"].as_object_mut().unwrap().remove("indicator_periods_candles");
        let err = validate_local_training_config(&config, VALID_TIMERANGE, VALID_TIMEFRAME).unwrap_err();
        assert!(err.contains("indicator_periods_candles"), "error should name the missing key, got: {err}");
    }

    #[test]
    fn rejects_an_empty_indicator_periods_candles() {
        let mut config = valid_config();
        config["freqai"]["feature_parameters"]["indicator_periods_candles"] = serde_json::json!([]);
        assert!(validate_local_training_config(&config, VALID_TIMERANGE, VALID_TIMEFRAME).is_err());
    }

    #[test]
    fn rejects_a_config_missing_include_shifted_candles() {
        let mut config = valid_config();
        config["freqai"]["feature_parameters"].as_object_mut().unwrap().remove("include_shifted_candles");
        let err = validate_local_training_config(&config, VALID_TIMERANGE, VALID_TIMEFRAME).unwrap_err();
        assert!(err.contains("include_shifted_candles"), "error should name the missing key, got: {err}");
    }

    #[test]
    fn rejects_a_config_missing_buffer_train_data_candles() {
        let mut config = valid_config();
        config["freqai"]["feature_parameters"].as_object_mut().unwrap().remove("buffer_train_data_candles");
        let err = validate_local_training_config(&config, VALID_TIMERANGE, VALID_TIMEFRAME).unwrap_err();
        assert!(err.contains("buffer_train_data_candles"), "error should name the missing key, got: {err}");
    }

    #[test]
    fn rejects_a_config_missing_shuffle_after_split() {
        // Regression coverage: `feat_dict["shuffle_after_split"]` in
        // freqtrade's data_kitchen.py is a raw subscript directly on the
        // feature_parameters dict (not a copy with merged defaults) — a
        // missing key here is a bare KeyError too.
        let mut config = valid_config();
        config["freqai"]["feature_parameters"].as_object_mut().unwrap().remove("shuffle_after_split");
        let err = validate_local_training_config(&config, VALID_TIMERANGE, VALID_TIMEFRAME).unwrap_err();
        assert!(err.contains("shuffle_after_split"), "error should name the missing key, got: {err}");
    }
}

// pairs must be a concrete list here, never the ".*/USDT" wildcard — see
// resolve_auto_select_pairs' doc comment for why that wildcard breaks
// download-data. This string only has to change whenever the *requested*
// download changes (pair count, manual pairlist, or timerange), not
// reproduce the request exactly — see the regression tests below, which
// exist because this exact bug (a changed slider value silently reusing a
// stale container's old data) has shipped once already.
fn compute_download_identity(
    static_download_pairs: &Option<Vec<String>>,
    clamped_pair_count: u32,
    timerange: &str,
) -> String {
    match static_download_pairs {
        Some(pairs) => format!("manual:{}:{timerange}", pairs.join(",")),
        None => format!("auto:{clamped_pair_count}:{timerange}"),
    }
}

#[cfg(test)]
mod download_identity_tests {
    use super::compute_download_identity;

    // Regression coverage for "the top-N slider stopped limiting the
    // download after the idempotent-training refactor": that refactor
    // made run_freqtrade_step_resumable skip/reattach based purely on a
    // bot_id-scoped container name, which can't by itself distinguish
    // "already downloaded this exact selection" from "already downloaded
    // a DIFFERENT selection". These tests pin down that the identity
    // string this now gates on actually varies with everything that
    // changes what download-data is asked to fetch.
    #[test]
    fn changes_with_auto_select_pair_count() {
        let a = compute_download_identity(&None, 20, "20260101-20260601");
        let b = compute_download_identity(&None, 30, "20260101-20260601");
        assert_ne!(a, b);
    }

    #[test]
    fn changes_with_manual_pairlist() {
        let a = compute_download_identity(&Some(vec!["BTC/USDT".into(), "ETH/USDT".into()]), 20, "20260101-20260601");
        let b = compute_download_identity(&Some(vec!["BTC/USDT".into()]), 20, "20260101-20260601");
        assert_ne!(a, b);
    }

    #[test]
    fn changes_with_timerange() {
        let a = compute_download_identity(&None, 20, "20260101-20260601");
        let b = compute_download_identity(&None, 20, "20260101-20260701");
        assert_ne!(a, b);
    }

    #[test]
    fn stable_for_an_identical_repeated_request() {
        let a = compute_download_identity(&None, 20, "20260101-20260601");
        let b = compute_download_identity(&None, 20, "20260101-20260601");
        assert_eq!(a, b);
    }

    #[test]
    fn auto_select_and_manual_never_collide() {
        // Same "20" appearing in both a pair count and a pairlist should
        // never accidentally produce the same identity.
        let auto = compute_download_identity(&None, 20, "20260101-20260601");
        let manual = compute_download_identity(&Some(vec!["20".into()]), 999, "20260101-20260601");
        assert_ne!(auto, manual);
    }
}

async fn remove_container(name: &str) {
    let mut cmd = Command::new("docker");
    cmd.args(["rm", "-f", name]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    hide_console_window(&mut cmd); // required here — see fix 22885bb; keep on every new Command in this file
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
    hide_console_window(&mut cmd); // required here — see fix 22885bb; keep on every new Command in this file
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
    hide_console_window(&mut cmd); // required here — see fix 22885bb; keep on every new Command in this file
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
        hide_console_window(&mut cmd); // required here — see fix 22885bb; keep on every new Command in this file
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
        hide_console_window(&mut cmd); // required here — see fix 22885bb; keep on every new Command in this file
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

// A throwaway probe config, written ONLY so freqtrade's own `test-pairlist`
// can resolve VolumePairList's live top-N-by-volume ranking — see
// resolve_auto_select_pairs below. This declares VolumePairList
// deliberately (that's the whole point: reuse freqtrade's own ranking
// algorithm exactly, rather than reimplementing an exchange's quoteVolume
// sort in Rust) but MUST NEVER be the config download-data or backtesting
// run against — see build_local_training_config's doc comment, checklist
// item 1, for why VolumePairList crashes backtesting outright. The caller
// (the data-source retry loop in train_local_model) always overwrites
// user_data/config.json with the real build_local_training_config output
// immediately after resolve_auto_select_pairs returns, before download-data
// or backtesting ever run — so there is no window where this probe config
// could leak into either of those steps.
fn build_pairlist_probe_config(data_source: &str, pair_count: u32) -> serde_json::Value {
    serde_json::json!({
        "stake_currency": "USDT",
        "stake_amount": "unlimited",
        "dry_run": true,
        "trading_mode": "spot",
        "exchange": {
            "name": data_source,
            "key": "",
            "secret": "",
            "pair_whitelist": [".*/USDT"],
            "pair_blacklist": [],
        },
        "pairlists": [{
            "method": "VolumePairList",
            "number_assets": pair_count,
            "sort_key": "quoteVolume",
            "min_value": 0,
            "refresh_period": 1800,
        }],
    })
}

// Resolves the concrete top-`pair_count` pairs by volume on `data_source`,
// via freqtrade's own `test-pairlist --print-json` (queries the exchange
// for live volume data, prints exactly the resolved pairs and nothing else
// to stdout — its own INFO/WARNING logging goes to stderr) run against the
// throwaway probe config above — the same mechanism this codebase's
// now-removed permanent data-server refresh script used for the identical
// problem. Returns the bare trading pairs only — CORR_PAIR is NOT unioned
// in here; the caller does that itself for the download-only pairs list,
// keeping this function's return value exactly what becomes
// config.json's pair_whitelist (see build_local_training_config).
async fn resolve_auto_select_pairs(
    app: &AppHandle,
    bot_id: &str,
    work_dir: &Path,
    data_source: &str,
    pair_count: u32,
) -> Result<Vec<String>, String> {
    emit_status(app, bot_id, format!("=== resolving the current top-{pair_count} pairlist by volume on '{data_source}' (test-pairlist) ==="));

    let user_data_dir = work_dir.join("user_data");
    let probe_config = build_pairlist_probe_config(data_source, pair_count);
    let probe_config_json = serde_json::to_vec_pretty(&probe_config).map_err(|e| e.to_string())?;
    std::fs::write(user_data_dir.join("config.json"), probe_config_json)
        .map_err(|e| format!("could not write probe config.json: {e}"))?;

    let mut cmd = Command::new("docker");
    cmd.args([
        "run",
        "--rm",
        "-v",
        &format!("{}:/freqtrade/user_data", user_data_dir.display()),
        FREQTRADE_DOCKER_IMAGE,
        "test-pairlist",
        "--config",
        "user_data/config.json",
        "--print-json",
    ])
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    hide_console_window(&mut cmd); // required here — see fix 22885bb; keep on every new Command in this file

    let output = cmd.output().await.map_err(|e| format!("could not spawn docker: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("test-pairlist exited with {}: {}", output.status, stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let pairs: Vec<String> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("could not parse test-pairlist output as JSON ({e}): {}", stdout.trim()))?;
    if pairs.is_empty() {
        return Err("test-pairlist resolved an empty pairlist".into());
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
    hide_console_window(&mut docker_cmd); // required here — see fix 22885bb; keep on every new Command in this file
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
    hide_console_window(&mut logs_cmd); // required here — see fix 22885bb; keep on every new Command in this file
    let mut logs_child = logs_cmd
        .spawn()
        .map_err(|e| format!("could not attach to the already-running container: {e}"))?;
    if let Some(stdout) = logs_child.stdout.take() {
        stream_stdout_as_progress(app, bot_id, stdout);
    }
    let _ = logs_child.wait().await;

    let mut wait_cmd = Command::new("docker");
    wait_cmd.args(["wait", container_name]).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    hide_console_window(&mut wait_cmd); // required here — see fix 22885bb; keep on every new Command in this file
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
