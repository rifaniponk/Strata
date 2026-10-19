"""A/B harness used for this tuning: start the server with a variant of strata-iq3_s.json, run a fixed workload
(decode, 4K/16K/32K fresh prompts, a 4-turn agent-style conversation, --long: 512 tokens after 32K), write JSON
to ./runs (not committed).

usage: python tune_ab.py NAME '{"set": {"--flag": "value" | null}, "env": {...}}' [--rounds N] [--long]
"""
import json, statistics, sys, time, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
import strata_bench as SB  # noqa: E402

OUT = Path(__file__).parent / "runs"
OUT.mkdir(exist_ok=True)
PORT = 8091
BASE = f"http://127.0.0.1:{PORT}"

DECODE_PROMPTS = [
    "Write a Python module implementing an LRU cache class with get, put, delete and resize methods, full docstrings, "
    "type hints, and a set of pytest unit tests covering edge cases.",
    "Explain in detail how a modern CPU executes instructions out of order: the reorder buffer, register renaming, "
    "reservation stations, branch prediction and what happens on a misprediction.",
    "Write a TypeScript React component for a sortable, filterable data table with pagination, and explain each "
    "design decision after the code.",
]


def apply(args, sets):
    out = list(args)
    for flag, val in sets.items():
        while flag in out:
            i = out.index(flag)
            # flags with a value vs boolean flags
            if i + 1 < len(out) and not out[i + 1].startswith("--"):
                del out[i:i + 2]
            else:
                del out[i]
        if val is True:
            out.append(flag)
        elif val is not None and val is not False:
            out += [flag, str(val)]
    return out


def filler(words):
    return SB.long_prompt(words)


def main():
    name, spec = sys.argv[1], json.loads(sys.argv[2])
    rounds = int(sys.argv[sys.argv.index("--rounds") + 1]) if "--rounds" in sys.argv else 2
    cfg = json.loads((ROOT / "strata-iq3_s.json").read_text())
    cfg["args"] = apply(cfg["args"], spec.get("set", {}))
    if spec.get("env"):
        cfg["env"] = {**cfg.get("env", {}), **spec["env"]}
    cfg["log"] = str(OUT / f"{name}.engine.log")
    cfg["port"] = PORT
    cpath = OUT / f"{name}.config.json"
    cpath.write_text(json.dumps(cfg, indent=1))
    Path(cfg["log"]).unlink(missing_ok=True)
    proc = SB.start_server(cpath, PORT, None, OUT / f"{name}.server.log")
    t0 = time.time()
    res = {"name": name, "spec": spec, "args": cfg["args"]}
    try:
        if not SB.wait_ready(BASE, "", proc, 600, log=lambda *a: None):
            res["error"] = "not ready"
            return
        res["load_s"] = round(time.time() - t0, 1)
        tag = uuid.uuid4().hex[:8]
        # warm-up (graph capture, first windows)
        SB.chat(BASE, "", [{"role": "user", "content": f"[{tag} w] Say hello in five languages."}], 64)
        SB.chat(BASE, "", [{"role": "user", "content": f"[{tag} w2]\n" + filler(1500) + "\nSummarize."}], 32)

        dec = []
        for r in range(rounds):
            for i, p in enumerate(DECODE_PROMPTS):
                d = SB.digest(SB.chat(BASE, "", [{"role": "user", "content": f"[{tag} d{r}{i}] {p}"}], 512))
                dec.append(d)
        res["decode"] = dec
        # prefill: fresh 4K and 16K, plus a 32K once; decode 128 tokens after 16K (long-context decode)
        pre = {}
        for label, words, n, mx in (("4k", 3000, 2, 16), ("16k", 12500, 2, 128), ("32k", 25000, 1, 128)):
            pre[label] = [SB.digest(SB.chat(BASE, "", [{"role": "user", "content": f"[{tag} p{label}{k}]\n" + filler(words) +
                                                         "\nWrite a long story using as many of these words as you can."}], mx))
                          for k in range(n)]
        res["prefill"] = pre
        # agent-style: conversation grows by ~2K tokens a turn, model answers 128 tokens
        msgs = [{"role": "system", "content": f"[{tag} agent] You are a coding assistant."}]
        agent = []
        for turn in range(4):
            msgs.append({"role": "user", "content": f"File part {turn}:\n" + filler(1500) + "\nWhat stands out? Be brief."})
            raw = SB.chat(BASE, "", msgs, 128)
            agent.append(SB.digest(raw))
            msgs.append({"role": "assistant", "content": raw["text"]})
        res["agent"] = agent
        if "--long" in sys.argv:
            res["long"] = [SB.digest(SB.chat(BASE, "", [{"role": "user", "content": f"[{tag} L{k}]\n" + filler(25000) +
                                                       "\nWrite a detailed essay about the history of computing."}], 512)) for k in range(2)]
        try:
            res["metrics_health"] = SB.try_json(BASE, "/health")
        except Exception:
            pass
    finally:
        SB.stop_server(proc)
        res["wall_s"] = round(time.time() - t0, 1)
        summarize(res)
        (OUT / f"{name}.json").write_text(json.dumps(res, indent=1))


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def summarize(res):
    s = {}
    if "decode" in res:
        dec = res["decode"]
        tot_tok = sum(d["generated_tokens"] or 0 for d in dec)
        tot_ms = sum(d["decode_ms"] or 0 for d in dec)
        s["decode_med"] = med(d["decode_tps"] for d in dec)
        s["decode_agg"] = round(tot_tok / tot_ms * 1000, 1) if tot_ms else None
        s["decode_per_prompt"] = [med(d["decode_tps"] for d in dec[i::3]) for i in range(3)]
        acc = sum(d["drafts_accepted"] or 0 for d in dec); off = sum(d["drafts_offered"] or 0 for d in dec)
        s["accept"] = round(acc / off, 3) if off else None
    if "prefill" in res:
        for k, v in res["prefill"].items():
            s[f"pp_{k}"] = med(d["prompt_tps"] for d in v)
            s[f"ttft_{k}"] = med(d["ttft_s"] for d in v)
        s["decode_16k"] = med(d["decode_tps"] for d in res["prefill"]["16k"])
        s["decode_32k"] = med(d["decode_tps"] for d in res["prefill"]["32k"])
    if "agent" in res:
        s["agent_ttft"] = [d["ttft_s"] for d in res["agent"]]
        s["agent_decode"] = med(d["decode_tps"] for d in res["agent"])
        s["errors"] = [d["err"] for k in ("decode", "agent") for d in res.get(k, []) if d["err"]]
    if "long" in res:
        s["decode_32k_long"] = med(d["decode_tps"] for d in res["long"])
        s["long_gen"] = [d["generated_tokens"] for d in res["long"]]
    res["summary"] = s
    print(json.dumps({"name": res["name"], "load_s": res.get("load_s"), "wall_s": res.get("wall_s"), **s, "error": res.get("error")}))


if __name__ == "__main__":
    main()
