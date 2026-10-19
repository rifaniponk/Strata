# Benchmark: RTX 5080 16 GB, Ryzen 9 9950X, 96 GB DDR5-6400 — Linux, commit dc874baa

A single 16 GB consumer card running IQ3_S with the full 131,072-token window.
Reported per [`docs/COMMUNITY_BENCHMARKS.md`](../../../docs/COMMUNITY_BENCHMARKS.md):
three runs per configuration, medians and ranges, prompt and decode throughput
kept apart. Measured **2026-10-19** on a local source build of the engine
(`0.1.44.1`, repo at `dc874baa`), same settings the previous RTX 5080 report
used (`--max-context 131072`), freshly set up on this machine the same day.

The headline: **decode speed roughly doubled** at every prompt length against
the earlier RTX 5080 report in this repo
([`2026-10-09-rtx-5080-0.1.41`](../2026-10-09-rtx-5080-0.1.41/README.md)) — 56.7
→ 122.8 tok/s at 4k, 50.4 → 126.0 tok/s at 32k, 53.9 → 121.9 tok/s at 128k —
while prefill also improved 25–83% and VRAM stayed flat. See
[Comparison to the earlier RTX 5080 report](#comparison-to-the-earlier-rtx-5080-report)
below for why this is not a clean single-variable comparison.

## Hardware and software

| | |
| --- | --- |
| GPU | NVIDIA GeForce RTX 5080, 16 GB (Blackwell, sm_120), driver 595.99.02 |
| PCIe | gen 5 x16 max (`max_link_speed` 32.0 GT/s, `max_link_width` 16); gen 1 at idle (`current_link_speed` 2.5 GT/s) |
| GPU power limit | 360 W |
| CPU | AMD Ryzen 9 9950X, 16 cores / 32 threads |
| RAM | 96 GB DDR5-6400 (2 × 48 GB; the speed as the owner set it, not probed); 91.9 GiB usable by Linux (`MemTotal`), after about 2 GiB for the integrated Radeon GPU and the firmware and kernel reservations |
| Storage | WD_BLACK SN8100 2 TB NVMe (model and packs) |
| OS | Ubuntu 26.04.1 LTS, kernel 7.0.0-38-generic |
| CUDA | 13.1 (local source build — no ready-made engine release existed for this version/arch yet, HTTP 404) |
| Strata | engine 0.1.44.1 (`engine/BUILD.json` attached), repo at `dc874baa`, source build with `CXX=g++-14` (Ubuntu 26.04 ships gcc 15 by default, which the CUDA 13.x host-compiler check rejects, see `docs/TROUBLESHOOTING.md`) |

The engine was compiled locally for sm_120 only (this card), not the
multi-arch ready-made release binary, so it is not a drop-in comparison of
*binaries* — only of what this repo's current source produces on this card.

## Model and configuration

Qwen3.8-Flash-Next **IQ3_S** (3.5 bpw), `ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF`,
two GGUF shards (54,817,524,224 + 28,800,138,432 bytes — identical sizes to the
earlier RTX 5080 report, same quant/source), and the MTP draft layer packed
into `Strata-data/mtp/rt`. No vision model installed on this install (`images: false`).

```
--pack Strata-data/packs/iq3_s --native ...IQ3_S-00001-of-00002.gguf
--ple-gguf ...IQ3_S-00002-of-00002.gguf --expert-profile data/expert-profile.bin
--expert-cache auto --prefill auto --spec 4 --spec-min-p 0.5
--mtp Strata-data/mtp/rt --max-context 131072 --kv int8 --kv-resident 32768
```

Full config attached as `strata-iq3_s.json`. `host 127.0.0.1` (default,
localhost-only), port 8080, GPU 0, no API key, no vision. `--max-context` was
raised from this install's default (65536, `./setup.sh`'s pick for a card
under 20 GiB VRAM) to 131072 specifically to match the earlier report's
window — otherwise the 128k-token test could not run. No `--calibrate` run on
this machine and no adaptive-expert-tier or `--pool-workers` tuning (the
engine's own default of 15 workers was used, against 5 on the earlier,
`--calibrate`-tuned report). The engine cached 4,448 experts in 8,689 MiB of
VRAM (against 3,669 experts / 7,184 MiB on the earlier report — likely headroom
freed by no `--vision` reservation here, not a smaller model).

## Method and reproduction

`benchmark.py` in this directory is an unmodified copy of the one in
[`2026-10-09-rtx-5080-0.1.41`](../2026-10-09-rtx-5080-0.1.41/README.md), which
itself is adapted from the
[2x TITAN RTX report](../2026-10-08-community-2x-titan-rtx-0.1.40.3/benchmark.py):
it records the server's own per-request facts (expert hit rate, PCIe share, MTP
acceptance) and GPU telemetry sampled once a second *while each request is in
flight*.

Three runs at each of 4,096 / 32,768 / 128,000 target prompt tokens, 256-token
output cap, `temperature=0`, non-streaming. Each run carries a distinct
`Document revision marker`, so no run reuses another's prefix (`cached_tokens`
was 0 on every run). A warm expert cache is shared across runs by design. The
prompt length is calibrated first with two cheap requests to learn the
tokenizer's tokens-per-repetition (76.0 here, same as the earlier report — same
tokenizer, same model).

```
python benchmark.py strata-iq3_s.json      # server already running on 127.0.0.1:8080
```

All nine runs finished with `finish_reason: stop`; none hit the token cap.
Per-run JSON in `rtx-5080-results.json`.

## Results — median (min–max of three runs)

| Metric | 4,096 | 32,768 | 128,000 |
| --- | --- | --- | --- |
| Prompt tokens (actual) | 4,179 | 32,832 | 128,061 |
| **Prefill tok/s** | **3,261.5** (3,255.4–3,263.8) | **3,776.1** (3,774.8–3,787.9) | **3,769.6** (3,767.7–3,772.0) |
| **Decode tok/s** | **122.8** (97.6–137.5) | **126.0** (125.8–132.5) | **121.9** (115.8–122.4) |
| Time to first token (s) | 1.30 (1.29–1.30) | 8.71 (8.68–8.71) | 34.00 (33.97–34.01) |
| Wall clock (s) | 2.51 (2.09–2.65) | 10.55 (10.44–10.59) | 36.00 (35.96–36.17) |
| Output tokens | 133 (111–150) | 235 (218–249) | 244 (236–249) |
| Expert cache hit rate | 0.871 (0.789–0.899) | 0.835 (0.834–0.846) | 0.839 (0.836–0.840) |
| MTP draft accepted | 73.2% (69.0–74.1) | 85.9% (83.0–89.4) | 80.5% (77.4–80.9) |
| VRAM peak (GiB) | 15.66 | 15.67 | 15.67 |
| GPU power peak (W) | 289 | 309 | 314 |
| GPU temp peak (°C) | 59 | 63 | 69 |

Latency histograms from `GET /metrics` across all 11 requests the server had
served by the end (the sweep plus calibration warm-ups): TTFT p50 7.92 s / p90
32.67 s, inter-token latency p50 7.7 ms, end-to-end p50 11.67 s. Server
totals: 496,260 prompt tokens, 1,827 generated, 1,138 of 1,417 drafts accepted
(80.3%).

`pcie_rx_peak_mb_s` was sampled (30,951–53,111 MB/s across runs) but, as the
earlier report notes for its own PCIe numbers, this exceeds what a gen 4 x16
link could sustain and is left out of the table above as a coarse NVML
counter, not a rate; the engine's own `pcie_share` (in `rtx-5080-results.json`)
is the trustworthy figure.

## Comparison to the earlier RTX 5080 report

[`2026-10-09-rtx-5080-0.1.41`](../2026-10-09-rtx-5080-0.1.41/README.md) measured the
same GPU model, same model/quant, same 131,072-token context, ten days earlier:

| | 4,096 | 32,768 | 128,000 |
| --- | --- | --- | --- |
| Prefill tok/s, old → new | 1,782.8 → 3,261.5 (+83%) | 2,884.3 → 3,776.1 (+31%) | 3,006.0 → 3,769.6 (+25%) |
| Decode tok/s, old → new | 56.7 → 122.8 (+117%) | 50.4 → 126.0 (+150%) | 53.9 → 121.9 (+126%) |
| TTFT s, old → new | 2.37 → 1.30 | 11.42 → 8.71 | 42.66 → 34.00 |
| VRAM peak GiB, old → new | 15.37 → 15.66 | 15.37 → 15.67 | 15.37 → 15.67 |

**This is not an isolated engine-version comparison.** The two reports share
the GPU model but differ in several other ways at once:

- **Different physical machine.** The earlier report ran on an Intel Core
  i7-14700 / Windows 11 / DDR4-3200 host; this one is an AMD Ryzen 9 9950X /
  Ubuntu 26.04 / DDR5-6400 host. CPU-side work — expert routing, attention,
  system-RAM expert fallback — is part of what decode speed measures here, and
  this CPU/platform may simply be faster at it, independent of any engine
  change.
- **Different engine provenance.** Earlier: engine 0.1.41, the ready-made
  multi-arch release binary. Here: engine 0.1.44.1, compiled locally for
  sm_120 only, because no ready-made release existed yet for this
  version/arch pairing (404 from the releases endpoint).
- **Different tuning.** The earlier run used `START-HERE.bat --calibrate`'s
  picks (`--pool-workers 5`, adaptive expert tier `--adapt-every 1
  --adapt-swaps 80 --adapt-decay 0.97`) and `--vision --vram-reserve-mib 700`.
  This run used none of those — default `--pool-workers` (15), no adaptive
  tier, no vision reservation — which is also most of why more experts fit in
  VRAM here (4,448 vs 3,669 slots) despite identical VRAM peaks.

So the ~2x decode improvement is real on this card, under these two specific
configurations, but it should not be read as "the engine got 2x faster
between 0.1.41 and 0.1.44.1" in isolation — platform and tuning differences
are mixed in. A same-machine, same-tuning, engine-only A/B (same host running
both 0.1.41 and 0.1.44.1) would be needed to separate those out.

## Notes and limits

**Not measured:** no needle/recall check (`tools/needle_bench.py`), no
concurrency sweep, no vision requests (none installed), no comparison against
llama.cpp, and no `--calibrate` run on this host (so `--pool-workers` and the
adaptive expert tier are at their engine defaults, not host-tuned). Single
machine, single session, no reboot between lengths. Total suite time: well
under 10 minutes including model load.

## Files

| File | |
| --- | --- |
| `benchmark.py` | the sweep, standard library only (unmodified copy of the earlier report's script) |
| `rtx-5080-results.json` | every run's raw record, plus the latency histograms and server totals |
| `strata-iq3_s.json` | the run config used (no API key set; server is localhost-only) |
| `BUILD.json` | the local engine build's metadata |
