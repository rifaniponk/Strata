# Benchmark: RTX 5080 16 GB, Core i7-14700, 128 GiB RAM — v0.1.41

A single 16 GB consumer card running IQ3_S with the full 131,072-token window.
Reported per [`docs/COMMUNITY_BENCHMARKS.md`](../../../docs/COMMUNITY_BENCHMARKS.md):
three runs per configuration, medians and ranges, prompt and decode throughput
kept apart. Measured **2026-10-09** on engine **0.1.41**, with the settings
`START-HERE --calibrate` chose on this PC the same day.

The headline: **decode speed is flat from 4k to 128k tokens** (50–57 tok/s), and
**prefill gets faster as the prompt grows** (1,783 → 3,006 tok/s). A long context
costs time to first token, not generation speed.

## Hardware and software

| | |
| --- | --- |
| GPU | NVIDIA GeForce RTX 5080, 16 GB (Blackwell, sm_120), driver 616.56 |
| PCIe | **gen 4 x16** negotiated — the GPU supports gen 5, the host tops out at gen 4 (`pcie.link.gen.gpumax` 5, `hostmax` 4); gen 1 at idle |
| GPU power limit | 360 W |
| CPU | Intel Core i7-14700, 20 cores / 28 threads |
| RAM | 127.8 GiB |
| Storage | MSI M480 PRO 2 TB NVMe (model and packs) |
| OS | Windows 11 Pro, build 26200 |
| CUDA | 13.0 (prebuilt release engine, not a source build) |
| Strata | engine 0.1.41 (`engine/BUILD.json` attached), repo at `99eb3ea` |

The engine is the ready-made release binary for sm_75/86/89/120 with PTX, not a
local build, so `CMAKE_*` options do not apply.

## Model and configuration

Qwen3.8-Flash-Next **IQ3_S** (3.5 bpw), `ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF`,
two GGUF shards (54,817,524,224 + 28,800,138,432 bytes), the BF16 mmproj vision
encoder (907,543,008 bytes), and the MTP draft layer packed into
`Strata-data/mtp/rt`.

```
--pack Strata-data/packs/iq3_s --native ...IQ3_S-00001-of-00002.gguf
--ple-gguf ...IQ3_S-00002-of-00002.gguf --expert-profile data/expert-profile.bin
--expert-cache auto --prefill auto --spec 4 --mtp Strata-data/mtp/rt
--max-context 131072 --kv int8 --kv-resident 32768 --vision --vram-reserve-mib 700
--spec-min-p 0.5 --pool-workers 5 --adapt-every 1 --adapt-swaps 80 --adapt-decay 0.97
```

Full config attached as `strata-iq3_s.json` (API key removed). `host 0.0.0.0`,
port 9191, GPU 0, vision on. The experimental speed projection was off.

**Calibration was enabled**, and is the reason for the last four flags.
`START-HERE.bat --calibrate` on 2026-10-09 measured 56.3 tok/s and kept
`--pool-workers 5` (down from 7) and the adaptive expert tier
(`--adapt-every 1 --adapt-swaps 80 --adapt-decay 0.97`). It did **not** keep a
`--pcie-frac` or a non-default `--spec-min-p`: both sweeps nominated a winner
(0.35 and 0.7) that failed the 3% interleaved-confirmation gate, so each went
back to the product default — `--spec-min-p 0.5` and no `--pcie-frac`. The
engine cached 3,669 experts in 7,184 MiB of VRAM.

## Method and reproduction

`benchmark.py` in this directory, adapted from the
[2x TITAN RTX report](../2026-10-08-community-2x-titan-rtx-0.1.40.3/benchmark.py)
and extended to record the server's own per-request facts (expert hit rate, PCIe
share, MTP acceptance) and GPU telemetry sampled once a second *while each
request is in flight*, so the peaks are what the run actually cost.

Three runs at each of 4,096 / 32,768 / 128,000 target prompt tokens, 256-token
output cap, `temperature=0`, non-streaming. Each run carries a distinct
`Document revision marker`, so no run reuses another's prefix (`cached_tokens`
was 0 on every run). A warm expert cache is shared across runs by design. The
prompt length is calibrated first with two cheap requests to learn the
tokenizer's tokens-per-repetition (76.0 here), so the targets land within 2%.

```
python benchmark.py ../../../strata-iq3_s.json      # STRATA_API_KEY in the environment
```

All nine runs finished with `finish_reason: stop`; none hit the token cap.
Per-run JSON in `rtx-5080-results.json`.

## Results — median (min–max of three runs)

| Metric | 4,096 | 32,768 | 128,000 |
| --- | --- | --- | --- |
| Prompt tokens (actual) | 4,179 | 32,832 | 128,061 |
| **Prefill tok/s** | **1,782.8** (1,767.9–1,784.5) | **2,884.3** (2,882.3–2,895.3) | **3,006.0** (2,918.7–3,025.3) |
| **Decode tok/s** | **56.7** (40.5–57.5) | **50.4** (48.4–51.6) | **53.9** (52.1–55.8) |
| Time to first token (s) | 2.37 (2.37–2.38) | 11.42 (11.38–11.42) | 42.66 (42.38–43.93) |
| Wall clock (s) | 4.93 (4.60–6.13) | 15.70 (15.55–15.73) | 46.94 (46.67–48.16) |
| Output tokens | 152 | 213 | 218 |
| Expert cache hit rate | 0.833 (0.759–0.849) | 0.791 (0.790–0.794) | 0.794 (0.791–0.794) |
| PCIe share of misses | 0.166 | 0.153 | 0.149 |
| MTP draft accepted | 73.9% (73.2–77.9) | 85.0% (83.0–86.5) | 80.4% (80.3–89.0) |
| VRAM peak (GiB) | 15.37 | 15.37 | 15.37 |
| GPU util mean | 96.3% | 97.1% | 99.6% |
| GPU power peak (W) | 189 | 273 | 275 |
| GPU temp peak (°C) | 51 | 61 | 64 |
| CPU mean | 34.2% | 28.1% | 25.1% |
| System RAM peak (GiB) | 90.3 | 90.3 | 90.7 |

Latency histograms from `GET /metrics` across all 17 requests the server had
served by the end (the sweep plus a few warm-ups): TTFT p50 1.96 s / p90 57.3 s,
inter-token latency p50 29.6 ms, end-to-end p50 5.63 s. Server totals: 496,637
prompt tokens, 43,108 generated, 27,548 of 35,948 drafts accepted (76.6%).

## Notes and limits

**The first run at 4k is cold, not slow.** 40.5 tok/s against 56.7 and 57.5 on
the two runs after it, with the expert cache hit rate climbing 0.759 → 0.833 →
0.849. It is left in the table rather than dropped, but the 4k decode median is
the honest figure and the range shows the warm-up. Every later length ran
against an already-warm cache. The warm 4k figure also agrees with the 56.3
tok/s `--calibrate` measured independently.

**Prefill improves with length.** 1,783 tok/s at 4k is the fixed per-request
cost dominating a short prompt; by 32k it is amortised and 128k is the fastest
of the sweep. There is no prefill degradation at the top of this window.

**VRAM does not move with context.** 15.37 GiB peak at every length: the expert
cache fills the card and `--kv-resident 32768` keeps KV growth off it, so a
128,000-token prompt costs no more VRAM than a 4,096-token one on this card.

**The PCIe throughput reading is not trustworthy and is therefore not in the
table above.** The sampler recorded peaks of 43,546 / 47,818 / 49,843 MB/s,
which is roughly 48 GB/s — above the ~31.5 GB/s ceiling of the gen 4 x16 link
this machine negotiated. NVML's `nvmlDeviceGetPcieThroughput` is a coarse
short-window counter, so these should be read as "the link was saturated during
prefill", not as a rate. The engine's own `pcie_share` (0.15–0.17 of expert
misses served over PCIe) is measured by Strata and is sound. The raw NVML
figures are kept in `rtx-5080-results.json` for anyone who wants them.

**Not measured:** no needle/recall check (`tools/needle_bench.py`), no
concurrency sweep (`--batch` is not enabled in this config, so every run was a
single request in a single slot), no vision requests despite `--vision` being
on, no comparison against llama.cpp, and no second quantisation. Single machine,
single session, no reboot between lengths.

## Files

| File | |
| --- | --- |
| `benchmark.py` | the sweep, standard library only |
| `rtx-5080-results.json` | every run's raw record, plus the latency histograms and server totals |
| `strata-iq3_s.json` | the run config, API key removed |
| `BUILD.json` | the engine binary's build metadata |
