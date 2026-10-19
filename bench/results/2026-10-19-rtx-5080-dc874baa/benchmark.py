#!/usr/bin/env python3
"""Prompt-length sweep against the running Strata server, in the shape docs/COMMUNITY_BENCHMARKS.md asks for:
three runs each at 4,096 / 32,768 / 128,000 prompt tokens, 256-token cap, temperature 0, non-streaming.

Adapted from bench/results/2026-10-08-community-2x-titan-rtx-0.1.40.3/benchmark.py, extended to record the
server's own per-request facts (expert hit rate, PCIe share, MTP acceptance) and the hardware sampled while
each request is in flight, not just after it.
"""
import json, os, statistics, sys, threading, time, urllib.request

# python benchmark.py [path/to/strata-<model>.json] - key from STRATA_API_KEY, else the config's.
CFG_PATH = sys.argv[1] if len(sys.argv) > 1 else "strata-iq3_s.json"
CFG = json.load(open(CFG_PATH, encoding="utf-8-sig"))
KEY = os.environ.get("STRATA_API_KEY") or CFG.get("api_key", "")
PORT = CFG.get("port", 9191)
BASE_URL = f"http://127.0.0.1:{PORT}"
OUT = os.path.dirname(os.path.abspath(__file__))
LENGTHS = (4096, 32768, 128000)
RUNS = 3
MAX_TOKENS = 256


def get(path):
    r = urllib.request.Request(BASE_URL + path, headers={"Authorization": "Bearer " + KEY})
    with urllib.request.urlopen(r, timeout=30) as f:
        return json.loads(f.read())


def chat(prompt, max_tokens=MAX_TOKENS, timeout=1800):
    body = json.dumps({"model": "strata", "messages": [{"role": "user", "content": prompt}],
                       "max_tokens": max_tokens, "temperature": 0, "stream": False}).encode()
    r = urllib.request.Request(BASE_URL + "/v1/chat/completions", data=body,
                               headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    t0 = time.time()
    with urllib.request.urlopen(r, timeout=timeout) as f:
        d = json.loads(f.read())
    return d, time.time() - t0


class Sampler(threading.Thread):
    """Poll /metrics while a request is in flight: the peak is what a 128k prompt actually costs."""

    def __init__(self):
        super().__init__(daemon=True)
        self.stop = threading.Event()
        self.rows = []

    def run(self):
        while not self.stop.is_set():
            try:
                self.rows.append(get("/metrics")["hardware"])
            except Exception:
                pass
            self.stop.wait(1.0)

    def summary(self):
        def peak(k):
            v = [r.get(k) for r in self.rows if isinstance(r.get(k), (int, float))]
            return round(max(v), 1) if v else None

        def mean(k):
            v = [r.get(k) for r in self.rows if isinstance(r.get(k), (int, float))]
            return round(statistics.mean(v), 1) if v else None
        return {"samples": len(self.rows), "gpu_util_mean": mean("gpu_util"), "gpu_util_peak": peak("gpu_util"),
                "vram_peak_gib": round((peak("gpu_mem_used") or 0) / 1073741824, 2),
                "gpu_temp_peak": peak("gpu_temp"), "gpu_power_peak": peak("gpu_power"),
                "pcie_rx_peak_mb_s": peak("gpu_pcie_rx_mb"), "cpu_mean": mean("cpu"),
                "ram_peak_gib": round((peak("ram_used") or 0) / 1073741824, 2)}


BASE = ("Sparse mixture-of-experts routing sends each token through a small subset of "
        "feed-forward experts. The gate projects hidden states into per-expert scores, applies a "
        "top-k mask and renormalizes the surviving weights. Recurrent delta layers maintain linear "
        "state across the sequence while sparse attention indexes only a subset of keys. "
        "Quantized weights trade numerical precision for memory bandwidth at every matmul. ")

ASK = "\n\nIn one short paragraph, state what the passage above is about."


def calibrate_tokens_per_rep():
    """One cheap request to learn this tokenizer's tokens-per-repetition, so the targets land close."""
    d, _ = chat(BASE * 10 + ASK, max_tokens=1)
    n = d["timings"]["prompt_n"]
    d0, _ = chat(BASE * 2 + ASK, max_tokens=1)
    n0 = d0["timings"]["prompt_n"]
    per = (n - n0) / 8.0
    print(f"  tokenizer: {per:.1f} tokens per repetition ({n0} at 2 reps, {n} at 10)", flush=True)
    return per


def make(target, per_rep, variant):
    reps = max(1, int(round(target / per_rep)))
    return f"Document revision marker {variant}. " + BASE * reps + ASK


def main():
    print("=== Strata prompt-length sweep ===", flush=True)
    st = get("/metrics")
    static, eng = st["hardware_static"], st["engine"]
    print(f"  {static.get('gpu_name')} | {static.get('cpu_name')} | "
          f"{static.get('cores')}c/{static.get('threads')}t", flush=True)
    print(f"  model {eng.get('model')} | context {eng.get('max_context')} | "
          f"experts cached {eng.get('expert_slots')}", flush=True)
    per_rep = calibrate_tokens_per_rep()

    results = {}
    for length in LENGTHS:
        runs = []
        for v in range(RUNS):
            prompt = make(length, per_rep, v + 1000 * (length // 1000))
            s = Sampler()
            s.start()
            try:
                d, wall = chat(prompt)
            finally:
                s.stop.set()
                s.join(timeout=5)
            tm, u = d.get("timings", {}), d.get("usage", {})
            rec = get("/metrics")["requests"][0]          # the server's own record of the run just finished
            row = {
                "variant": v, "target_tokens": length,
                "prompt_tokens": tm.get("prompt_n"), "prompt_ms": tm.get("prompt_ms"),
                "prefill_tok_s": tm.get("prompt_per_second"),
                "cached_tokens": tm.get("cache_n"),
                "output_tokens": tm.get("predicted_n"), "decode_ms": tm.get("predicted_ms"),
                "decode_tok_s": tm.get("predicted_per_second"),
                "draft_n": tm.get("draft_n"), "draft_accepted": tm.get("draft_n_accepted"),
                "mtp_accept_pct": round(100 * tm["draft_n_accepted"] / tm["draft_n"], 1)
                if tm.get("draft_n") else None,
                "ttft_s": rec.get("ttft_s"), "wall_s": round(wall, 2),
                "finish": d["choices"][0].get("finish_reason"),
                "hit_rate": rec.get("hit_rate"), "pcie_share": rec.get("pcie_share"),
                "file_mb": rec.get("file_mb"), "ram_blobs": rec.get("ram_blobs"),
                "hw": s.summary(),
            }
            runs.append(row)
            print(f"  {length:>6} run {v + 1}/{RUNS}: prompt {row['prompt_tokens']} tok at "
                  f"{row['prefill_tok_s']} tok/s | decode {row['decode_tok_s']} tok/s | "
                  f"ttft {row['ttft_s']} s | wall {row['wall_s']} s | hit {row['hit_rate']} | "
                  f"vram {row['hw']['vram_peak_gib']} GiB", flush=True)
        results[str(length)] = runs

    def stat(rows, key, nd=1):
        v = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
        if not v:
            return None
        return {"runs": [round(x, nd) for x in v], "median": round(statistics.median(v), nd),
                "min": round(min(v), nd), "max": round(max(v), nd)}

    summary = {}
    for k, rows in results.items():
        summary[k] = {"prompt_tokens": stat(rows, "prompt_tokens", 0),
                      "prefill_tok_s": stat(rows, "prefill_tok_s", 1),
                      "decode_tok_s": stat(rows, "decode_tok_s", 2),
                      "ttft_s": stat(rows, "ttft_s", 2),
                      "wall_s": stat(rows, "wall_s", 2),
                      "hit_rate": stat(rows, "hit_rate", 3),
                      "mtp_accept_pct": stat(rows, "mtp_accept_pct", 1),
                      "vram_peak_gib": stat([{"v": r["hw"]["vram_peak_gib"]} for r in rows], "v", 2),
                      "gpu_power_peak": stat([{"v": r["hw"]["gpu_power_peak"]} for r in rows], "v", 0),
                      "gpu_temp_peak": stat([{"v": r["hw"]["gpu_temp_peak"]} for r in rows], "v", 0),
                      "pcie_rx_peak_mb_s": stat([{"v": r["hw"]["pcie_rx_peak_mb_s"]} for r in rows], "v", 0)}

    final = get("/metrics")
    out = {"static": static, "engine": eng, "settings": CFG["args"],
           "latency_histograms": final.get("latency"), "totals": final.get("totals"),
           "summary": summary, "runs": results}
    with open(os.path.join(OUT, "rtx-5080-results.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    print("=== SUMMARY ===", flush=True)
    print(json.dumps(summary, indent=1), flush=True)


if __name__ == "__main__":
    sys.exit(main())
