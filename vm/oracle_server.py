#!/usr/bin/env python3
# file: vm/oracle_server.py
"""三值判定服务（python 版）—— 只做 HTTP 外壳，判定语义照 vm/oracle-contract.json 实现。

为什么要这一份：目标里的 L3 是「跑在 Kali VM 里」，而 Kali 上没有 node（2026-11-16 实测）。
在 VM 里再装一份 node 等于养第二份运行时；所以这里用 python 复刻同一套公式，
但**阈值与参数一律从契约文件读**（vm/export-contract.mjs 生成），并且有对拍测试
（test/vm_oracle_parity.test.mjs）拿随机向量比两边的结论 —— 公式写两遍的风险靠对拍兜，
不靠自觉。

纪律与 node 版一致：
  - 只读无状态：不写盘、不记日志文件
  - fail-closed：畸形输入 4xx，不替调用方猜
  - 只判数据不判人：入参只有数值

用法：
  python3 vm/oracle_server.py --host 0.0.0.0 --port 8731
  curl -s http://127.0.0.1:8731/health
  curl -s -X POST http://127.0.0.1:8731/judge -d '{"zValues":[3.1,2.9,3.4],"expected":9}'
"""

import argparse
import json
import math
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT_PATH = os.path.join(HERE, "oracle-contract.json")
MAX_BODY = 64 * 1024

with open(CONTRACT_PATH, "r", encoding="utf-8") as fh:
    CONTRACT = json.load(fh)

CUT_HIGH = float(CONTRACT["cut"]["high"])
CUT_MID = float(CONTRACT["cut"]["mid"])
Z_LIMIT = float(CONTRACT["zLimit"])
SPREAD_EPS = float(CONTRACT["spreadEps"])
EXPECTED_DEFAULT = int(CONTRACT["expectedDefault"])
# 到票率下限：应评 N 人得回来 0.8N 张。来自契约，不许写死。
VOTE_ARITY = float(CONTRACT["votes"]["arity"])
STARTED = time.time()
VERSION = "1.0.0-py"


def reading(item, idx, sources=None):
    """一条读数 → (raw, z 截断后, 来源标签)；无效读数返回 None。与 node 侧同口径。"""
    label = None
    if isinstance(item, dict):
        val = item.get("z", item.get("value"))
        label = item.get("source", item.get("src"))
    else:
        val = item
    if label is None and isinstance(sources, list) and idx < len(sources):
        # 与 node 侧同一个三级回落：对象自带 source 优先，其次平行数组 sources[idx]。
        label = sources[idx]
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        return None
    n = float(val)
    if not math.isfinite(n):
        return None
    return (n, max(-Z_LIMIT, min(Z_LIMIT, n)), None if label is None else str(label))


def compute_confidence(z_values, expected=None, sources=None):
    """与 vm/judge.mjs 的 computeConfidence 逐步对齐（顺序也一致，浮点误差才对得上）。

    2026-11-16 第二步：按来源去重（无标签按原始读数去重）+ n<2 时 agreement=0。
    去重键必须用**截断前**的原值 —— 3.1/3.2/3.4 都会被截成 3，用截断值当键会把三条
    独立指标压成一条。这是 node 侧踩过、对拍抓到的同一个坑。
    """
    arr = z_values if isinstance(z_values, list) else []
    groups, order = {}, []
    for i, item in enumerate(arr):
        rd = reading(item, i, sources)
        if rd is None:
            continue
        raw, z, label = rd
        key = ("src:" + label) if label is not None else ("val:%.9f" % raw)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(z)
    values = [sum(groups[k]) / len(groups[k]) for k in order]
    exp = expected if isinstance(expected, int) and expected > 0 else max(len(arr), EXPECTED_DEFAULT)
    n_sources = len(values)
    n_valid = min(1.0, n_sources / exp) if exp else 0.0
    if not values:
        return {"strength": 0.0, "agreement": 0.0, "nValid": 0.0, "confidence": 0.0, "meanZ": 0.0,
                "spread": 0.0, "nSources": 0, "rawCount": len(arr)}
    mean_z = sum(values) / n_sources
    var = sum((z - mean_z) * (z - mean_z) for z in values) / n_sources
    sd = math.sqrt(var)
    spread = sd if sd > 0 else SPREAD_EPS
    strength = math.tanh(abs(mean_z))
    # 一个来源不能自证：n=1 时 agreement 恒为 0（不这么写，单值读数永远「一致」）。
    agreement = math.tanh(abs(mean_z) / spread) if n_sources >= 2 else 0.0
    return {"strength": strength, "agreement": agreement, "nValid": n_valid,
            "confidence": strength * agreement * n_valid, "meanZ": mean_z, "spread": spread,
            "nSources": n_sources, "rawCount": len(arr)}


def verdict_of(confidence):
    c = float(confidence)
    if not math.isfinite(c):
        return -1
    if c >= CUT_HIGH:
        return 1
    if c >= CUT_MID:
        return 0
    return -1


LABEL = {1: "可判", 0: "存疑", -1: "别判"}


def judge(z_values, expected=None, sources=None):
    st = compute_confidence(z_values, expected, sources)
    direct = verdict_of(st["confidence"])
    if direct == 1 and st["meanZ"] == 0:
        return {"value": -1, "confidence": st["confidence"], "reason": "decoupled-guard", "stats": st, "engine": "python"}
    reason = {1: "可判", 0: "存疑", -1: "别判"}[direct]
    return {"value": direct, "confidence": st["confidence"], "reason": reason, "stats": st, "engine": "python"}


VOTE_MAP = {"ACCEPT": 1, "A": 1, "+1": 1, "REVISE": -1, "R": -1, "-1": -1,
            "UNREVIEWED": None, "NONE": None, "NULL": None, "0": None, "": None}


def parse_vote(v):
    """None=没评成；'BAD'=认不出（调用方必须报错，不许静默吞）。"""
    if v is None:
        return None
    if not isinstance(v, str):
        return "BAD"
    key = v.strip().upper()
    if key not in VOTE_MAP:
        return "BAD"
    return VOTE_MAP[key]


def judge_votes(votes, expected=None):
    # 每张票是一个独立来源（评审人 id，缺省 ballot:i）—— 三张 ACCEPT 是三个证据，
    # 不会被 compute_confidence 的「按值去重」压成一票。
    z, sources, counts = [], [], {"ACCEPT": 0, "REVISE": 0, "unreviewed": 0, "invalid": 0}
    for i, raw in enumerate(votes):
        val = raw.get("value", raw.get("vote")) if isinstance(raw, dict) else raw
        label = None
        if isinstance(raw, dict):
            label = raw.get("reviewer", raw.get("source"))
        v = parse_vote(val)
        if v == "BAD":
            counts["invalid"] += 1
        elif v is None:
            counts["unreviewed"] += 1
        elif v > 0:
            z.append(1); sources.append(str(label) if label is not None else "ballot:%d" % i); counts["ACCEPT"] += 1
        else:
            z.append(-1); sources.append(str(label) if label is not None else "ballot:%d" % i); counts["REVISE"] += 1
    declared = int(expected) if isinstance(expected, int) and expected > 0 else 0
    roster_missing = declared == 0
    exp = declared if declared else len(votes)
    r = judge(z, exp, sources)
    cast = counts["ACCEPT"] + counts["REVISE"]
    turnout = (cast / exp) if exp else 0.0
    below_arity = (turnout + 1e-12) < VOTE_ARITY
    mean_z = r["stats"]["meanZ"]
    direction = 1 if mean_z > 0 else (-1 if mean_z < 0 else 0)
    if r["value"] == 1:
        state = "ACCEPT" if direction > 0 else ("REVISE" if direction < 0 else "unreviewed")
    else:
        state = "unreviewed"
    # reason 一律机器码，人话放 reasonText —— 必须与 node 的 vm/votes.mjs 同口径，
    # 否则同一个 /votes 在 python 版回 "别判"、node 版回 "insufficient"，
    # 下游按 reason 判断的程序在两台机器上行为不同（这就是对拍没比 reason 时漏掉的漂移）。
    reason = ("consensus-accept" if state == "ACCEPT" else
              "consensus-revise" if state == "REVISE" else
              "no-direction" if r["value"] == 1 else
              "undecided" if r["value"] == 0 else
              "insufficient")
    reason_text = None if r["value"] == 1 else r["reason"]
    value = r["value"]
    if roster_missing:
        # 没有声明应评名单：到票率不可算，绝不允许落成 ACCEPT。
        value = 0 if r["value"] == 1 else r["value"]
        state = "unreviewed"
        reason = "no-roster"
        reason_text = "没有声明应评名单：到票率无从计算（补 --expect 名单 或 --expect-n N）"
    elif below_arity:
        # 到票不足：原来判 +1 的降级成 0（缺席不等于同意）；本来就 ≤0 的保留原值。
        value = 0 if r["value"] == 1 else r["value"]
        state = "unreviewed"
        reason = "insufficient"
        reason_text = "到票 %d/%d（%.2f）低于应评下限 %s" % (cast, exp, turnout, VOTE_ARITY)
    return {"value": value, "state": state, "direction": direction,
            "confidence": r["confidence"], "reason": reason, "reasonText": reason_text,
            "turnout": turnout, "arity": VOTE_ARITY, "rosterMissing": roster_missing,
            "counts": counts, "expected": exp, "stats": r["stats"],
            "cut": {"high": CUT_HIGH, "mid": CUT_MID}, "engine": "python"}


def parse_expected(raw):
    if raw is None or raw == "":
        return None, True
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None, False
    return (n, True) if n > 0 else (None, False)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ternary-oracle/" + VERSION

    def log_message(self, fmt, *args):  # 不留日志文件；只走 stderr 一行
        pass

    def _send(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("content-length") or 0)
        if length > MAX_BODY:
            self.rfile.read(length)
            return None, length
        return self.rfile.read(length).decode("utf-8") if length else "", length

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/") or "/"
        query = {}
        if "?" in self.path:
            for pair in self.path.split("?", 1)[1].split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    query[k] = v
        if path == "/health":
            return self._send(200, {"ok": True, "service": "ternary-oracle", "version": VERSION,
                                    "engine": "python", "uptimeMs": int((time.time() - STARTED) * 1000),
                                    "contractVersion": CONTRACT.get("contractVersion"),
                                    "cut": {"high": CUT_HIGH, "mid": CUT_MID}, "zLimit": Z_LIMIT,
                                    "votesArity": (CONTRACT.get("votes") or {}).get("arity"),
                                    "endpoints": ["/health", "/judge", "/votes"]})
        if path == "/judge":
            raw = query.get("z", "")
            parts = [p for p in raw.replace(",", " ").split() if p]
            nums, bad = [], []
            for p in parts:
                try:
                    nums.append(float(p))
                except ValueError:
                    bad.append(p)
            if bad:
                return self._send(400, {"ok": False, "error": "z 里有非数字: " + ",".join(bad)})
            exp, ok = parse_expected(query.get("expected"))
            if not ok:
                return self._send(400, {"ok": False, "error": "expected 必须是正数"})
            if not nums:
                return self._send(400, {"ok": False, "error": "zValues 不能为空（没有数据时不该问判定，直接不该判）"})
            return self._send(200, {"ok": True, **self._project(judge(nums, exp))})
        if path in ("/judge", "/votes"):
            return self._send(405, {"ok": False, "error": "GET 不允许，用 POST"})
        return self._send(404, {"ok": False, "error": "没有这个接口: " + path,
                                "endpoints": ["/health", "/judge", "/votes"]})

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/") or "/"
        text, size = self._body()
        if text is None:
            return self._send(413, {"ok": False, "error": "请求体超过 %d 字节（收到 %d）" % (MAX_BODY, size)})
        try:
            body = json.loads(text or "{}")
        except json.JSONDecodeError:
            return self._send(400, {"ok": False, "error": "请求体不是合法 JSON"})
        if path == "/judge":
            if isinstance(body, list):
                z_values, exp_raw = body, None
            elif isinstance(body, dict):
                z_values = body.get("zValues", body.get("z", []))
                exp_raw = body.get("expected")
            else:
                return self._send(400, {"ok": False, "error": "请求体要是数组或对象"})
            if not isinstance(z_values, list):
                return self._send(400, {"ok": False, "error": "zValues 必须是数组"})
            exp, ok = parse_expected(exp_raw)
            if not ok:
                return self._send(400, {"ok": False, "error": "expected 必须是正数"})
            bad = [v for i, v in enumerate(z_values) if reading(v, i) is None]
            if bad:
                return self._send(400, {"ok": False, "error": "zValues 里有非数字", "bad": bad[:8]})
            if not z_values:
                return self._send(400, {"ok": False, "error": "zValues 不能为空（没有数据时不该问判定，直接不该判）"})
            return self._send(200, {"ok": True, **self._project(judge(z_values, exp))})
        if path == "/votes":
            if not isinstance(body, dict):
                return self._send(400, {"ok": False, "error": "请求体要是对象"})
            votes = body.get("votes")
            exp, ok = parse_expected(body.get("expected"))
            if not ok:
                return self._send(400, {"ok": False, "error": "expected 必须是正数"})
            if not isinstance(votes, list):
                return self._send(400, {"ok": False, "error": "votes 必须是数组（ACCEPT / REVISE / null）"})
            unknown = [v for v in votes if parse_vote(v) == "BAD"]
            if unknown:
                return self._send(400, {"ok": False, "error": "votes 里有无法识别的取值", "bad": unknown[:8]})
            return self._send(200, {"ok": True, **judge_votes(votes, exp)})
        if path in ("/judge", "/votes"):
            return self._send(405, {"ok": False, "error": "POST 不允许这个接口"})
        return self._send(404, {"ok": False, "error": "没有这个接口: " + path,
                                "endpoints": ["/health", "/judge", "/votes"]})

    def _project(self, r):
        st = r["stats"]
        return {"value": r["value"], "confidence": r["confidence"], "reason": r["reason"],
                "label": LABEL[r["value"]],
                "stats": {"strength": st["strength"], "agreement": st["agreement"], "nValid": st["nValid"],
                          "meanZ": st["meanZ"], "spread": st["spread"], "nSources": st.get("nSources")},
                "checked": None, "engine": "python"}


def main():
    ap = argparse.ArgumentParser(description="ternary-oracle (python)")
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8731")))
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    # 真实端口写出来：测试用 --port 0 让系统分配，得知道分到哪个。
    print("[ternary-oracle] py v%s 监听 http://%s:%d" % (VERSION, args.host, srv.server_address[1]), flush=True)
    print("[ternary-oracle] 契约 high>=%s / mid>=%s" % (CUT_HIGH, CUT_MID), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
