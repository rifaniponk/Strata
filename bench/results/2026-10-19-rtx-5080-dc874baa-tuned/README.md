# Benchmark: RTX 5080 16 GB, Ryzen 9 9950X — the same install, tuned (commit dc874baa)

The same machine, engine build, model and `benchmark.py` as
[`2026-10-19-rtx-5080-dc874baa`](../2026-10-19-rtx-5080-dc874baa/README.md) (measured the same morning),
with the engine settings tuned for this PC by whole-engine A/B runs. Only the config's settings differ.
Reported per [`docs/COMMUNITY_BENCHMARKS.md`](../../../docs/COMMUNITY_BENCHMARKS.md): three runs per
length, medians and ranges, prompt and decode throughput kept apart. Measured **2026-10-19**.

The headline: against the untuned run on this machine, prefill is **+1.7% to +2.2%** at every length and decode is
**+5.6% to +6.8%** at 32k and 128k; at 4k the decode gain (+1.6%) is inside the run-to-run range. Against the
earlier report from the old machine ([`2026-10-09-rtx-5080-0.1.41`](../2026-10-09-rtx-5080-0.1.41/README.md),
i7-14700, Windows, engine 0.1.41), decode is **2.2-2.7x** and prefill **1.27-1.86x**.

## Hardware and software

Unchanged from [`2026-10-19-rtx-5080-dc874baa`](../2026-10-19-rtx-5080-dc874baa/README.md):

| | |
| --- | --- |
| GPU | NVIDIA GeForce RTX 5080, 16 GB (Blackwell, sm_120), driver 595.99.02, PCIe gen 5 x16 |
| CPU | AMD Ryzen 9 9950X, 16 cores / 32 threads, power profile `balanced` (amd_pstate active) |
| RAM | 92 GiB |
| OS | Ubuntu 26.04.1 LTS, kernel 7.0.0-38-generic |
| CUDA | 13.1 (local source build for sm_120, `BUILD.json` attached) |
| Strata | engine 0.1.44.1, repo at `dc874baa` (no engine or server code changed) |
| Background | Docker Desktop's VM running (about 8 GB RAM, light CPU), as in normal use |

## Model and configuration

Qwen3.8-Flash-Next **IQ3_S** (ISTA-DASLab GSQ-RCO GGUF, the same two shards), MTP draft layer, no vision,
`--max-context 131072`. The settings that changed against the untuned config:

| Setting | Untuned | Tuned | What it does |
| --- | --- | --- | --- |
| `--adapt-every` / `--adapt-swaps` / `--adapt-decay` | engine default (4 / 96 / 0.7) | `1` / `160` / `0.97` | the VRAM expert cache follows the conversation every window, swaps more and remembers longer |
| `STRATA_ADAPT_OVERLAP` (config `env`) | off | `1` | the adaptive tier's copies land while the next window runs (same tokens) |
| `--kv-resident` | `32768` | `20480` | fewer K/V cells per layer kept in VRAM (the rest streams from pinned RAM); the room goes to the expert cache |
| `--aux-cpus` | off | `auto` | helper and driver threads off the pool workers' cores |
| `--vram-reserve-mib` | engine default (700) | `1024` | the untuned config left 336 MiB free and the engine warned of driver paging (#2065); now 658 MiB free, no warning |

Everything else is as before (`--spec 4 --spec-min-p 0.5 --kv int8 --expert-cache auto --prefill auto`,
15 pool workers, the PCIe share set by the engine). The expert cache holds 4,360 experts (8.32 GiB), against
4,448 untuned: the larger reserve costs more slots than the smaller K/V frees. Full config in `strata-iq3_s.json`
(home directory shown as `~`).

## Method and reproduction

`benchmark.py` is an unmodified copy of the one in the two earlier RTX 5080 reports. Three runs at each of
4,096 / 32,768 / 128,000 target prompt tokens, 256-token output cap, `temperature=0`, non-streaming, a distinct
revision marker per run (`cached_tokens` 0 on every run). The server was started fresh with the tuned config
(port 8091 instead of 8080, which another program held; the benchmark reads the port from the config it is given).

```
python benchmark.py strata-iq3_s.json      # server already running with this config
```

All nine runs finished with `finish_reason: stop`. Per-run JSON in `rtx-5080-results.json`.

## Results — median (min–max of three runs)

| Metric | 4,096 | 32,768 | 128,000 |
| --- | --- | --- | --- |
| Prompt tokens (actual) | 4,179 | 32,832 | 128,061 |
| **Prefill tok/s** | **3,324.3** (3,281.5–3,334.1) | **3,860.0** (3,848.0–3,862.2) | **3,831.9** (3,825.5–3,833.6) |
| **Decode tok/s** | **124.8** (117.7–131.7) | **134.6** (130.2–135.4) | **128.7** (127.3–131.2) |
| Time to first token (s) | 1.27 (1.26–1.28) | 8.52 (8.52–8.55) | 33.45 (33.43–33.50) |
| Wall clock (s) | 2.34 (2.31–2.59) | 10.13 (10.12–10.15) | 35.38 (35.18–35.41) |
| Output tokens | 134 (122–176) | 213 (212–218) | 241 (221–253) |
| Expert cache hit rate | 0.891 (0.879–0.891) | 0.837 (0.834–0.843) | 0.841 (0.832–0.842) |
| MTP draft accepted | 73.2% (67.9–76.8) | 83.6% (80.8–89.2) | 83.5% (82.0–86.2) |
| VRAM peak (GiB) | 15.35 | 15.36 | 15.36 |
| GPU power peak (W) | 281 | 311 | 313 |
| GPU temp peak (°C) | 59 | 62 | 66 |

`GET /metrics` across the server's 11 requests: TTFT p50 7.92 s / p90 32.67 s, inter-token latency p50 7.5 ms
(7.7 ms untuned), end-to-end p50 11.67 s; 1,129 of 1,390 drafts accepted (81.2%).

## Comparison

| | 4,096 | 32,768 | 128,000 |
| --- | --- | --- | --- |
| Prefill tok/s, 10-09 old machine → 10-19 untuned → **tuned** | 1,782.8 → 3,261.5 → **3,324.3** | 2,884.3 → 3,776.1 → **3,860.0** | 3,006.0 → 3,769.6 → **3,831.9** |
| Decode tok/s, 10-09 old machine → 10-19 untuned → **tuned** | 56.7 → 122.8 → **124.8** | 50.4 → 126.0 → **134.6** | 53.9 → 121.9 → **128.7** |
| TTFT s, 10-09 old machine → 10-19 untuned → **tuned** | 2.37 → 1.30 → **1.27** | 11.42 → 8.71 → **8.52** | 42.66 → 34.00 → **33.45** |
| Tuned vs untuned (same machine) | prefill +1.9%, decode +1.6% | prefill +2.2%, decode +6.8% | prefill +1.7%, decode +5.6% |
| Tuned vs 10-09 (old machine) | prefill 1.86x, decode 2.20x | prefill 1.34x, decode 2.67x | prefill 1.27x, decode 2.39x |

The untuned → tuned step changes the settings only. The 10-09 step also changes the machine (i7-14700, Windows 11,
DDR4-3200), the engine (0.1.41 release binary) and its tuning, so it is not an engine-only comparison (see the
untuned report).

The 4k decode figures rest on answers of 111-176 tokens and spread over ±7% within a run of three, so the gain
there cannot be told from noise in this benchmark.

## How the settings were chosen (`tuning-ab.json`, `tune_ab.py`)

Each candidate was measured as a whole-engine run of `tune_ab.py`, one config per run, each with a fresh
server: 6 answers of 512 tokens (code, an explanation, a React component, twice), fresh 4K, 16K and 32K prompts,
a 4-turn agent-style conversation growing about 2K tokens a turn, and in the final round 2 answers of 512 tokens
after a 32K prompt. Decode is total generated tokens over total decode time of the 6 answers. Four untuned
runs spread over the sweep gave 132.9–135.6 tok/s, so a single-run difference below about 3% was not trusted.

Single changes against the untuned config (decode tok/s; prefill at 16K where it moved):

| Change | Decode | Kept? |
| --- | --- | --- |
| untuned (4 runs) | 132.9–135.6 | |
| `--adapt-every 1 --adapt-swaps 160 --adapt-decay 0.97` | 137.3 (after 16K: 122.8 vs 100-108) | yes |
| `--adapt-every 1 --adapt-swaps 80 --adapt-decay 0.97` | 137.2 | (160 won the final) |
| `--kv-resident 20480` | 137.7 | yes |
| `--aux-cpus auto` | 136.5, prefill 16K 3,841 vs 3,754-3,783 | yes |
| `--vram-reserve-mib 896` | 134.4 (free VRAM still fell to 502 MiB: 1024 used) | yes, as 1024 |
| `--pool-workers 11` / `7` (default 15) | 132.5 / 126.5 | no |
| `--spec 3` / `--spec 6` (setup's 4) | 125.1 / 129.6 | no |
| `--spec-min-p 0.3` / `0.7` (setup's 0.5) | 131.4 / 134.5 | no |
| `--pcie-frac 0.3` / `0.55` (engine sets it: 0.40 here) | 130.3 / 129.6 | no |
| `--kv k8v4` | 135.4, prefill 16K 3,542 (−6%) | no |
| `--kv-grow`, `--mtp-q4 all`, `STRATA_ARENA_THP=1` | 132.7, 133.3, 135.4 | no |

The kept settings together, then variations of them (one run each): 160 swaps 140.6, 80 swaps 140.0, 320 swaps 138.7,
plus `--adapt-async 1` 139.1, plus `STRATA_ADAPT_OVERLAP=1` 146.2, plus `--spec 5 --spec-min-p 0.7` 137.2, without
`--aux-cpus` 141.2 (but prefill 16K 3,756 against 3,852).

Final round, interleaved (untuned, 80 swaps + overlap, 160 swaps + overlap, three times), medians of 3:

| | untuned | 80 swaps + overlap | 160 swaps + overlap |
| --- | --- | --- | --- |
| Decode, 512-token answers | 132.9 | 143.3 | **146.1** |
| Decode after 16K (128 tokens) | 105.0 | 120.6 | **120.8** |
| Decode after 32K (512 tokens) | 113.8 | 115.2 | **118.5** |
| Prefill 16K | 3,764.5 | 3,849.9 | **3,839.8** |
| Prefill 32K | 3,680.4 | 3,782.0 | **3,761.8** |

The CPU power profile `performance` (instead of `balanced`) was tried with the tuned config (143.2 and 142.4) and
the untuned one (135.1): no gain, so the machine stays on `balanced`.

## Notes and limits

**Not measured:** answer quality. The adaptive tier and the K/V split change which experts the GPU computes, and
the GPU rounds differently from the CPU, so answers can differ slightly from the untuned config's; no needle/recall
or task check was run. No concurrency (`--batch`), no vision. One machine, one session; the tuning runs and this
benchmark ran within about four hours of the untuned report, without a reboot. The settings were tuned for decode
on this PC: `STRATA_ADAPT_OVERLAP` lost 21% on an RTX 5090 Laptop (docs/DETAILS.md), so measure it on another
machine before copying it.

## Files

| File | |
| --- | --- |
| `benchmark.py` | the sweep, unmodified copy of the earlier reports' script |
| `rtx-5080-results.json` | every run's raw record, latency histograms and server totals (home directory shown as `~`) |
| `strata-iq3_s.json` | the tuned run config (no API key; localhost only; home directory shown as `~`) |
| `tuning-ab.json` | the summary of every A/B tuning run behind the table above |
| `tune_ab.py` | the A/B harness that produced `tuning-ab.json` |
| `BUILD.json` | the local engine build's metadata |
