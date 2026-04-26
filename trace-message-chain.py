#!/usr/bin/env python3
import argparse
import ast
import json
import os
import re
from datetime import datetime
from glob import glob
from typing import Any, Dict, List, Optional, Tuple


LOG_LINE_RE = re.compile(
    r'^(?P<ts>\S+)\s+\[chat:(?P<worker>[^\]]+)\]\[(?P<trace>[^\]]+)\]\s+\+(?P<ms>\d+)ms\s+(?P<msg>.*)$'
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Trace full chain and timing by messageId (traceId/msgId)."
    )
    parser.add_argument("message_id", help="messageId in UI (e.g. be9397af)")
    parser.add_argument(
        "--app-support",
        default=os.path.expanduser("~/Library/Application Support/Clawin Desktop"),
        help="App support directory (default: ~/Library/Application Support/Clawin Desktop)",
    )
    return parser.parse_args()


def parse_iso(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def ms_between(a: Optional[datetime], b: Optional[datetime]) -> Optional[float]:
    if not a or not b:
        return None
    return (b - a).total_seconds() * 1000.0


def short_text(text: str, max_len: int = 100) -> str:
    text = (text or "").replace("\n", " ").strip()
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "..."


def read_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def find_in_chat_history(chat_history_path: str, message_id: str) -> Optional[Dict[str, Any]]:
    if not os.path.exists(chat_history_path):
        return None

    data = read_json(chat_history_path)

    messages = data.get("messages", {})
    for worker_id, items in messages.items():
        if not isinstance(items, list):
            continue
        for idx, msg in enumerate(items):
            if not isinstance(msg, dict):
                continue
            if msg.get("msgId") == message_id:
                prev_user = None
                for j in range(idx - 1, -1, -1):
                    p = items[j]
                    if isinstance(p, dict) and p.get("role") == "user":
                        prev_user = p
                        break
                return {
                    "scope": "worker",
                    "worker_id": worker_id,
                    "index": idx,
                    "assistant": msg,
                    "prev_user": prev_user,
                }

    group_messages = data.get("groupMessages", {})
    for group_id, items in group_messages.items():
        if not isinstance(items, list):
            continue
        for idx, msg in enumerate(items):
            if not isinstance(msg, dict):
                continue
            if msg.get("id") == message_id or msg.get("msgId") == message_id:
                return {
                    "scope": "group",
                    "group_id": group_id,
                    "index": idx,
                    "assistant": msg,
                    "prev_user": None,
                }

    return None


def parse_fields_from_lines(lines: List[str]) -> Dict[str, Optional[str]]:
    out: Dict[str, Optional[str]] = {
        "run_id": None,
        "session_id": None,
        "session_key": None,
        "provider": None,
        "model": None,
        "duration_ms": None,
    }

    patterns = {
        "run_id": re.compile(r'"runId"\s*:\s*"([^"]+)"'),
        "session_id": re.compile(r'"sessionId"\s*:\s*"([^"]+)"'),
        "session_key": re.compile(r'"sessionKey"\s*:\s*"([^"]+)"'),
        "provider": re.compile(r'"provider"\s*:\s*"([^"]+)"'),
        "model": re.compile(r'"model"\s*:\s*"([^"]+)"'),
        "duration_ms": re.compile(r'"durationMs"\s*:\s*(\d+)'),
    }

    for line in lines or []:
        for key, pat in patterns.items():
            if out[key] is not None:
                continue
            m = pat.search(line)
            if m:
                out[key] = m.group(1)
    return out


def parse_metadata_from_logs(log_lines: List[Dict[str, Any]]) -> Dict[str, Optional[str]]:
    return parse_fields_from_lines([item.get("msg", "") for item in log_lines])


def find_log_lines(logs_dir: str, message_id: str) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for path in sorted(glob(os.path.join(logs_dir, "chat-*.log"))):
        try:
            with open(path, "r", encoding="utf-8") as f:
                for i, line in enumerate(f, start=1):
                    if f"[{message_id}]" not in line:
                        continue
                    line = line.rstrip("\n")
                    m = LOG_LINE_RE.match(line)
                    if not m:
                        continue
                    results.append(
                        {
                            "file": path,
                            "line": i,
                            "raw": line,
                            "ts": m.group("ts"),
                            "worker": m.group("worker"),
                            "trace": m.group("trace"),
                            "plus_ms": int(m.group("ms")),
                            "msg": m.group("msg"),
                        }
                    )
        except OSError:
            continue
    return results


def summarize_log_timing(log_lines: List[Dict[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "start": None,
        "spawn": None,
        "first_status": None,
        "exit": None,
        "done": None,
        "spawn_session_id": None,
        "http_agent_start": None,
        "http_fetch_start": None,
        "http_fetch_end": None,
        "http_failed": None,
        "http_reply": None,
        "cli_fallback_start": None,
        "cli_start": None,
        "req_meta": None,
    }
    for item in log_lines:
        msg = item["msg"]
        if out["start"] is None and msg.startswith("START "):
            out["start"] = item
        if out["req_meta"] is None and msg.startswith("HTTP req meta "):
            out["req_meta"] = item
        if out["http_agent_start"] is None and msg.startswith("HTTP-agent") and msg.endswith(" start"):
            out["http_agent_start"] = item
        if out["http_fetch_start"] is None and "HTTP fetch →" in msg:
            out["http_fetch_start"] = item
        if out["http_fetch_end"] is None and "HTTP fetch ←" in msg:
            out["http_fetch_end"] = item
        if out["http_failed"] is None and msg.startswith("HTTP-agent") and " failed:" in msg:
            out["http_failed"] = item
        if out["http_reply"] is None and msg.startswith("HTTP reply len="):
            out["http_reply"] = item
        if out["cli_fallback_start"] is None and msg.startswith("CLI-agent fallback start"):
            out["cli_fallback_start"] = item
        if out["cli_start"] is None and msg.startswith("CLI-agent start"):
            out["cli_start"] = item
        if out["spawn"] is None and "spawn pid=" in msg:
            out["spawn"] = item
            sm = re.search(r"session=([^\s]+)", msg)
            if sm:
                out["spawn_session_id"] = sm.group(1)
        if out["first_status"] is None and "status:" in msg:
            out["first_status"] = item
        if out["exit"] is None and "CLI exit code=" in msg:
            out["exit"] = item
        if out["done"] is None and msg.startswith("DONE "):
            out["done"] = item
    return out


def infer_route(timing: Dict[str, Any]) -> str:
    has_http = timing.get("http_agent_start") is not None or timing.get("http_fetch_start") is not None
    has_cli = timing.get("spawn") is not None or timing.get("cli_start") is not None
    has_fallback = timing.get("cli_fallback_start") is not None
    if has_http and has_cli and has_fallback:
        return "HTTP -> CLI fallback"
    if has_http and not has_cli:
        return "HTTP only"
    if has_cli and not has_http:
        return "CLI only"
    if has_http and has_cli:
        return "HTTP + CLI"
    return "unknown"


def parse_req_meta(msg: str) -> Dict[str, Optional[str]]:
    fields = {
        "gateway_model": None,
        "configured_model": None,
        "text_len": None,
        "images": None,
        "history": None,
    }
    pats = {
        "gateway_model": re.compile(r"gatewayModel=([^\s]+)"),
        "configured_model": re.compile(r"configuredModel=([^\s]+)"),
        "text_len": re.compile(r"textLen=(\d+)"),
        "images": re.compile(r"images=(\d+)"),
        "history": re.compile(r"history=(\d+)"),
    }
    for k, p in pats.items():
        m = p.search(msg)
        if m:
            fields[k] = m.group(1)
    return fields


def parse_http_fetch_end(msg: str) -> Dict[str, Optional[str]]:
    out = {"status": None, "duration_ms": None}
    m = re.search(r"HTTP fetch ←\s+(\d+)\s+\((\d+)ms\)", msg)
    if m:
        out["status"] = m.group(1)
        out["duration_ms"] = m.group(2)
    return out


def extract_braced_object(text: str, start: int) -> Optional[str]:
    depth = 0
    in_str = False
    escape = False
    quote = ""
    begin = -1

    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == quote:
                in_str = False
            continue

        if ch in ('"', "'"):
            in_str = True
            quote = ch
            continue
        if ch == "{":
            if depth == 0:
                begin = i
            depth += 1
            continue
        if ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and begin >= 0:
                    return text[begin : i + 1]
    return None


def parse_jsonish_object(text: str) -> Optional[Dict[str, Any]]:
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    try:
        obj = ast.literal_eval(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    return None


def flatten_scalars(obj: Any, prefix: str = "") -> Dict[str, str]:
    out: Dict[str, str] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            out.update(flatten_scalars(v, key))
    elif isinstance(obj, list):
        for idx, v in enumerate(obj):
            key = f"{prefix}[{idx}]" if prefix else f"[{idx}]"
            out.update(flatten_scalars(v, key))
    elif isinstance(obj, (str, int, float, bool)):
        if prefix:
            out[prefix] = str(obj)
    return out


def parse_http_usage_from_text(text: str) -> Dict[str, str]:
    usage: Dict[str, str] = {}
    lowered = text.lower()

    usage_pos = lowered.find("usage")
    if usage_pos >= 0:
        brace_pos = text.find("{", usage_pos)
        if brace_pos >= 0:
            obj_text = extract_braced_object(text, brace_pos)
            if obj_text:
                parsed = parse_jsonish_object(obj_text)
                if isinstance(parsed, dict):
                    usage.update(flatten_scalars(parsed))

    for m in re.finditer(
        r"([A-Za-z_][A-Za-z0-9_.-]*(?:token|tokens)[A-Za-z0-9_.-]*)\s*[:=]\s*\"?(\d+)\"?",
        text,
        flags=re.IGNORECASE,
    ):
        usage[m.group(1)] = m.group(2)

    return usage


def parse_http_usage_from_custom(custom_row: Optional[Tuple[int, Dict[str, Any]]]) -> Dict[str, str]:
    if not custom_row:
        return {}

    _, row = custom_row
    data = row.get("data")
    if not isinstance(data, dict):
        return {}

    out: Dict[str, str] = {}
    for k, v in data.items():
        kl = str(k).lower()
        if kl == "usage" and isinstance(v, dict):
            out.update(flatten_scalars(v))
        elif "token" in kl and isinstance(v, (str, int, float, bool)):
            out[str(k)] = str(v)
    return out


def collect_http_token_usage(
    log_lines: List[Dict[str, Any]], timing: Dict[str, Any], chain: Optional[Dict[str, Any]]
) -> Dict[str, str]:
    out: Dict[str, str] = {}

    candidates: List[str] = []
    for item in log_lines:
        msg = item.get("msg", "")
        lm = msg.lower()
        if "http" in lm and ("usage" in lm or "token" in lm):
            candidates.append(msg)

    if timing.get("http_reply"):
        candidates.append(timing["http_reply"]["msg"])

    for text in candidates:
        out.update(parse_http_usage_from_text(text))

    if chain:
        out.update(parse_http_usage_from_custom(chain.get("custom_row")))

    return out


def find_jsonl_by_session_id(sessions_root: str, session_id: str) -> Optional[str]:
    pattern = os.path.join(sessions_root, "agents", "*", "sessions", f"{session_id}.jsonl")
    matches = glob(pattern)
    return matches[0] if matches else None


def find_jsonl_by_run_id(sessions_root: str, run_id: str) -> Optional[str]:
    pattern = os.path.join(sessions_root, "agents", "*", "sessions", "*.jsonl")
    for path in glob(pattern):
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    if run_id in line:
                        return path
        except OSError:
            continue
    return None


def read_jsonl(path: str) -> List[Tuple[int, Dict[str, Any]]]:
    rows: List[Tuple[int, Dict[str, Any]]] = []
    with open(path, "r", encoding="utf-8") as f:
        for i, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append((i, json.loads(line)))
            except json.JSONDecodeError:
                continue
    return rows


def find_chain_in_jsonl(rows: List[Tuple[int, Dict[str, Any]]], run_id: Optional[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "custom_row": None,
        "user_row": None,
        "assistant_row": None,
        "window": [],
    }

    custom_idx = None
    if run_id:
        for idx, obj in rows:
            if obj.get("type") != "custom":
                continue
            data = obj.get("data")
            if isinstance(data, dict) and data.get("runId") == run_id:
                custom_idx = idx
                out["custom_row"] = (idx, obj)
                break

    if custom_idx is None:
        return out

    by_idx = {idx: obj for idx, obj in rows}
    start = max(1, custom_idx - 4)
    end = min(max(by_idx.keys()), custom_idx + 1)
    out["window"] = [(i, by_idx[i]) for i in range(start, end + 1) if i in by_idx]

    for i in range(custom_idx - 1, 0, -1):
        obj = by_idx.get(i)
        if not obj or obj.get("type") != "message":
            continue
        msg = obj.get("message", {})
        if msg.get("role") == "assistant":
            out["assistant_row"] = (i, obj)
            break

    if out["assistant_row"]:
        i0 = out["assistant_row"][0]
        for i in range(i0 - 1, 0, -1):
            obj = by_idx.get(i)
            if not obj or obj.get("type") != "message":
                continue
            msg = obj.get("message", {})
            if msg.get("role") == "user":
                out["user_row"] = (i, obj)
                break

    return out


def extract_first_text_block(message_obj: Dict[str, Any]) -> str:
    message = message_obj.get("message", {})
    content = message.get("content")
    if not isinstance(content, list):
        return ""
    for blk in content:
        if isinstance(blk, dict) and blk.get("type") == "text":
            return blk.get("text", "")
    return ""


def find_session_key_in_sessions_json(app_support: str, worker_id: Optional[str], session_id: Optional[str]) -> Optional[str]:
    if not worker_id or not session_id:
        return None
    p = os.path.join(
        app_support,
        "runtime",
        "openclaw-home",
        ".openclaw",
        "agents",
        worker_id,
        "sessions",
        "sessions.json",
    )
    if not os.path.exists(p):
        return None
    try:
        data = read_json(p)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    for k, v in data.items():
        if isinstance(v, dict) and v.get("sessionId") == session_id:
            return k
    return None


def fmt_ms(v: Optional[float]) -> str:
    if v is None:
        return "N/A"
    return f"{v:.0f} ms ({v / 1000.0:.2f} s)"


def main() -> None:
    args = parse_args()
    message_id = args.message_id.strip()
    app_support = os.path.abspath(os.path.expanduser(args.app_support))

    chat_history_path = os.path.join(app_support, "chat-history.json")
    runtime_root = os.path.join(app_support, "runtime")
    logs_dir = os.path.join(runtime_root, "logs")
    openclaw_root = os.path.join(runtime_root, "openclaw-home", ".openclaw")

    history_hit = find_in_chat_history(chat_history_path, message_id)
    if not history_hit:
        print(f"messageId not found in chat-history: {message_id}")
        print(f"checked: {chat_history_path}")
        return

    assistant = history_hit["assistant"]
    prev_user = history_hit.get("prev_user")
    log_lines = find_log_lines(logs_dir, message_id)
    timing = summarize_log_timing(log_lines)
    status_info = parse_metadata_from_logs(log_lines)

    worker_id = history_hit.get("worker_id")
    if not worker_id and log_lines:
        worker_id = log_lines[0].get("worker")
    run_id = status_info.get("run_id")
    session_id = status_info.get("session_id")

    jsonl_path = None
    if session_id:
        jsonl_path = find_jsonl_by_session_id(openclaw_root, session_id)
    if not jsonl_path and run_id:
        jsonl_path = find_jsonl_by_run_id(openclaw_root, run_id)

    chain = None
    if jsonl_path and run_id:
        rows = read_jsonl(jsonl_path)
        chain = find_chain_in_jsonl(rows, run_id)

    session_key = status_info.get("session_key")
    if not session_key:
        session_key = find_session_key_in_sessions_json(app_support, worker_id, session_id)

    print("== Message ==")
    print(f"messageId(traceId): {message_id}")
    print(f"scope: {history_hit.get('scope')}")
    if worker_id:
        print(f"workerId: {worker_id}")
    if history_hit.get("group_id"):
        print(f"groupId: {history_hit.get('group_id')}")
    print(f"assistantTimestamp(ms): {assistant.get('timestamp')}")
    print(f"assistantPreview: {short_text(str(assistant.get('content', '')))}")
    if prev_user:
        print(f"userPreview: {short_text(str(prev_user.get('content', '')))}")

    print("\n== IDs Mapping ==")
    print(f"runId: {run_id or 'N/A'}")
    print(f"spawn session-id(arg): {timing.get('spawn_session_id') or 'N/A'}")
    print(f"openclaw sessionKey: {session_key or 'N/A'}")
    print(f"openclaw sessionId: {session_id or 'N/A'}")
    print(f"provider/model: {status_info.get('provider') or 'N/A'} / {status_info.get('model') or 'N/A'}")

    print("\n== Route ==")
    route = infer_route(timing)
    print(f"route: {route}")
    if timing.get("req_meta"):
        req_meta = parse_req_meta(timing["req_meta"]["msg"])
        print(
            "http req meta: "
            f"gatewayModel={req_meta['gateway_model'] or 'N/A'} "
            f"configuredModel={req_meta['configured_model'] or 'N/A'} "
            f"textLen={req_meta['text_len'] or 'N/A'} "
            f"images={req_meta['images'] or 'N/A'} "
            f"history={req_meta['history'] or 'N/A'}"
        )
    if timing.get("http_fetch_end"):
        http_end = parse_http_fetch_end(timing["http_fetch_end"]["msg"])
        print(
            "http response: "
            f"status={http_end['status'] or 'N/A'} "
            f"fetchDuration={fmt_ms(float(http_end['duration_ms'])) if http_end['duration_ms'] else 'N/A'}"
        )
    if timing.get("http_failed"):
        print(f"http failed: {timing['http_failed']['msg']}")
    if timing.get("http_reply"):
        print(f"http reply: {timing['http_reply']['msg']}")
    if route.startswith("HTTP"):
        token_usage = collect_http_token_usage(log_lines, timing, chain)
        if token_usage:
            joined = " ".join(f"{k}={v}" for k, v in sorted(token_usage.items()))
            print(f"http token usage: {joined}")
        else:
            print("http token usage: N/A (no usage/token fields found in logs or session custom data)")

    print("\n== Main Log Timeline ==")
    if not log_lines:
        print("No [chat:*][messageId] log lines found.")
    else:
        print(f"log file: {log_lines[0]['file']}")
        for item in log_lines:
            print(f"L{item['line']}: {item['ts']} +{item['plus_ms']}ms {item['msg']}")

    print("\n== Session Transcript ==")
    if not jsonl_path:
        print("session jsonl not found")
    else:
        print(f"jsonl: {jsonl_path}")
        if chain and chain.get("window"):
            for idx, obj in chain["window"]:
                t = obj.get("type")
                ts = obj.get("timestamp")
                mid = obj.get("id")
                pid = obj.get("parentId")
                if t == "message":
                    role = obj.get("message", {}).get("role")
                    text = short_text(extract_first_text_block(obj), 120)
                    print(f"line {idx}: type=message role={role} id={mid} parent={pid} ts={ts} text={text}")
                elif t == "custom":
                    data = obj.get("data", {})
                    print(
                        f"line {idx}: type=custom customType={obj.get('customType')} id={mid} parent={pid} ts={ts} runId={data.get('runId')} sessionId={data.get('sessionId')}"
                    )
                else:
                    print(f"line {idx}: type={t} id={mid} parent={pid} ts={ts}")

    print("\n== Timing Breakdown ==")
    start = timing.get("start")
    spawn = timing.get("spawn")
    first_status = timing.get("first_status")
    exit_row = timing.get("exit")
    done = timing.get("done")

    def pm(x: Optional[Dict[str, Any]]) -> Optional[float]:
        return x.get("plus_ms") if x else None

    total_main = None
    if start and done:
        total_main = done["plus_ms"] - start["plus_ms"]
    print(f"main total (START->DONE): {fmt_ms(total_main)}")

    if spawn and first_status:
        print(f"spawn -> first status: {fmt_ms(first_status['plus_ms'] - spawn['plus_ms'])}")
    else:
        print("spawn -> first status: N/A")

    if timing.get("http_fetch_start") and timing.get("http_fetch_end"):
        print(
            "http fetch window: "
            f"{fmt_ms(timing['http_fetch_end']['plus_ms'] - timing['http_fetch_start']['plus_ms'])}"
        )
    else:
        print("http fetch window: N/A")

    if spawn and exit_row:
        print(f"spawn -> CLI exit: {fmt_ms(exit_row['plus_ms'] - spawn['plus_ms'])}")
    else:
        print("spawn -> CLI exit: N/A")

    model_duration = status_info.get("duration_ms")
    if model_duration is not None:
        print(f"model durationMs (from status): {fmt_ms(float(model_duration))}")
    else:
        print("model durationMs (from status): N/A")

    if chain and chain.get("user_row") and chain.get("assistant_row"):
        u = chain["user_row"][1]
        a = chain["assistant_row"][1]
        dt = ms_between(parse_iso(u.get("timestamp")), parse_iso(a.get("timestamp")))
        print(f"jsonl user -> assistant: {fmt_ms(dt)}")
    else:
        print("jsonl user -> assistant: N/A")

    if start and chain and chain.get("user_row"):
        start_ts = parse_iso(start.get("ts"))
        user_ts = parse_iso(chain["user_row"][1].get("timestamp"))
        print(f"main START -> jsonl user: {fmt_ms(ms_between(start_ts, user_ts))}")
    else:
        print("main START -> jsonl user: N/A")

    if chain and chain.get("assistant_row") and done:
        assistant_ts = parse_iso(chain["assistant_row"][1].get("timestamp"))
        done_ts = parse_iso(done.get("ts"))
        print(f"jsonl assistant -> main DONE: {fmt_ms(ms_between(assistant_ts, done_ts))}")
    else:
        print("jsonl assistant -> main DONE: N/A")


if __name__ == "__main__":
    main()
