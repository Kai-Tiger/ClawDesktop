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

ANSI_BOLD_RED = "\033[1;31m"
ANSI_RESET = "\033[0m"


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
        "http_error_detail": None,
        "http_error_probe": None,
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
        if out["http_error_detail"] is None and "HTTP fetch err detail" in msg:
            out["http_error_detail"] = item
        if out["http_error_probe"] is None and "HTTP fetch err probe" in msg:
            out["http_error_probe"] = item
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


def to_int(v: Any) -> Optional[int]:
    try:
        if isinstance(v, bool):
            return None
        if isinstance(v, int):
            return v
        if isinstance(v, float):
            return int(v)
        s = str(v).strip()
        if not s:
            return None
        return int(float(s))
    except Exception:
        return None


def normalize_real_usage(raw_usage: Dict[str, str]) -> Dict[str, Optional[int]]:
    candidates: Dict[str, Optional[int]] = {
        "prompt_tokens": None,
        "completion_tokens": None,
        "total_tokens": None,
        "cache_read_tokens": None,
        "input_tokens": None,
    }

    for k, v in raw_usage.items():
        kl = k.lower()
        iv = to_int(v)
        if iv is None:
            continue

        if "prompt_tokens" in kl:
            candidates["prompt_tokens"] = iv
        elif "completion_tokens" in kl:
            candidates["completion_tokens"] = iv
        elif "total_tokens" in kl or kl.endswith(".total"):
            candidates["total_tokens"] = iv
        elif "cacheread" in kl or "cache_read" in kl:
            candidates["cache_read_tokens"] = iv
        elif kl.endswith(".input") or kl == "input":
            candidates["input_tokens"] = iv
    return candidates


def find_tool_schema_dump(logs_dir: str, trace_id: str) -> Optional[str]:
    p = os.path.join(logs_dir, f"tool-schema-dump-{trace_id}.json")
    if os.path.exists(p):
        return p
    return None


def find_runtime_usage_by_trace(logs_dir: str, openclaw_root: str, trace_id: str, run_id: Optional[str]) -> Optional[Dict[str, Any]]:
    specific = os.path.join(logs_dir, f"gateway-runtime-usage-{trace_id}.json")
    specific_obj: Optional[Dict[str, Any]] = None
    if os.path.exists(specific):
        try:
            obj = read_json(specific)
            if isinstance(obj, dict):
                specific_obj = obj
        except Exception:
            pass

    local_jsonl_path = os.path.join(logs_dir, "gateway-runtime-usage-by-trace.jsonl")
    runtime_jsonl_path = os.path.join(openclaw_root, "logs", "gateway-runtime-usage.jsonl")

    def score_obj(obj: Dict[str, Any]) -> int:
        score = 0
        if str(obj.get("traceId") or "") == trace_id:
            score += 100
        if run_id and str(obj.get("runId") or "") == run_id:
            score += 40
        spr = obj.get("systemPromptReport")
        if isinstance(spr, dict):
            score += 40
            skills = spr.get("skills") if isinstance(spr.get("skills"), dict) else {}
            tools = spr.get("tools") if isinstance(spr.get("tools"), dict) else {}
            sp = spr.get("systemPrompt") if isinstance(spr.get("systemPrompt"), dict) else {}
            if to_int(skills.get("promptChars")) is not None:
                score += 20
            if to_int(tools.get("schemaChars")) is not None:
                score += 20
            if to_int(sp.get("chars")) is not None:
                score += 20
        pr = obj.get("promptReport")
        if isinstance(pr, dict):
            score += 10
            if to_int(pr.get("skillsPromptChars")) is not None:
                score += 10
        return score

    def scan_jsonl(path: str) -> Optional[Dict[str, Any]]:
        if not os.path.exists(path):
            return None
        best: Optional[Tuple[int, Dict[str, Any]]] = None
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    if str(obj.get("traceId") or "") != trace_id and (not run_id or str(obj.get("runId") or "") != run_id):
                        continue
                    sc = score_obj(obj)
                    if best is None or sc >= best[0]:
                        best = (sc, obj)
        except OSError:
            return None
        return best[1] if best else None

    candidates = [c for c in [specific_obj, scan_jsonl(local_jsonl_path), scan_jsonl(runtime_jsonl_path)] if c]
    if not candidates:
        return None
    candidates.sort(key=lambda o: score_obj(o), reverse=True)
    return candidates[0]


def summarize_system_context(dump: Dict[str, Any]) -> Dict[str, Any]:
    request_meta = dump.get("requestMeta") if isinstance(dump.get("requestMeta"), dict) else {}
    injected = dump.get("injectedFiles") if isinstance(dump.get("injectedFiles"), dict) else {}
    skills = dump.get("skills") if isinstance(dump.get("skills"), dict) else {}
    memory = dump.get("memory") if isinstance(dump.get("memory"), dict) else {}

    injected_char_fields: List[Tuple[str, int]] = []
    injected_total_chars = 0
    for k, v in injected.items():
        if not k.endswith("Chars"):
            continue
        iv = to_int(v)
        if iv is None:
            continue
        injected_char_fields.append((k, iv))
        injected_total_chars += iv

    skills_entries = skills.get("entries") if isinstance(skills.get("entries"), list) else []
    skills_count = to_int(skills.get("count"))
    if skills_count is None:
        skills_count = len(skills_entries)
    skills_block_chars = 0
    for e in skills_entries:
        if not isinstance(e, dict):
            continue
        bc = to_int(e.get("blockChars"))
        if bc is not None:
            skills_block_chars += bc

    referenced = memory.get("referencedPaths") if isinstance(memory.get("referencedPaths"), list) else []

    return {
        "text_len": to_int(request_meta.get("textLen")),
        "history_count": to_int(request_meta.get("historyCount")),
        "image_count": to_int(request_meta.get("imageCount")),
        "injected_total_chars": injected_total_chars,
        "injected_char_fields": sorted(injected_char_fields, key=lambda x: x[0]),
        "skills_count": skills_count,
        "skills_block_chars": skills_block_chars,
        "memory_total_files": to_int(memory.get("totalFiles")),
        "memory_referenced_paths": len(referenced),
    }


def flatten_numeric_fields(obj: Any, prefix: str = "") -> Dict[str, int]:
    out: Dict[str, int] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            out.update(flatten_numeric_fields(v, key))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            key = f"{prefix}[{i}]" if prefix else f"[{i}]"
            out.update(flatten_numeric_fields(v, key))
    else:
        iv = to_int(obj)
        if iv is not None and prefix:
            out[prefix] = iv
    return out


def pick_metric_with_source(flat: Dict[str, int], rules: List[Any]) -> Tuple[Optional[int], Optional[str]]:
    scored: List[Tuple[int, str, int]] = []
    for path, value in flat.items():
        path_lc = path.lower()
        best = 0
        for rule in rules:
            try:
                score = int(rule(path_lc))
            except Exception:
                score = 0
            if score > best:
                best = score
        if best > 0:
            scored.append((best, path, value))
    if not scored:
        return None, None
    scored.sort(key=lambda x: x[0], reverse=True)
    _, source, value = scored[0]
    return value, source


def sum_skill_md_chars(dump: Optional[Dict[str, Any]]) -> Optional[int]:
    if not isinstance(dump, dict):
        return None
    skills = dump.get("skills")
    if not isinstance(skills, dict):
        return None
    entries = skills.get("entries")
    if not isinstance(entries, list):
        return None
    total = 0
    has_any = False
    for e in entries:
        if not isinstance(e, dict):
            continue
        iv = to_int(e.get("skillMdChars"))
        if iv is None:
            continue
        total += iv
        has_any = True
    return total if has_any else None


def extract_prompt_report_from_log_lines(log_lines: List[Dict[str, Any]]) -> Dict[str, int]:
    out: Dict[str, int] = {}
    pats = {
        "systemPrompt.chars": re.compile(r'"?systemPrompt\.chars"?\s*[:=]\s*(\d+)', re.IGNORECASE),
        "tools.schemaChars": re.compile(r'"?tools\.schemaChars"?\s*[:=]\s*(\d+)', re.IGNORECASE),
        "skills.promptChars": re.compile(r'"?skills\.promptChars"?\s*[:=]\s*(\d+)', re.IGNORECASE),
        "projectContextChars": re.compile(r'"?projectContextChars"?\s*[:=]\s*(\d+)', re.IGNORECASE),
        "nonProjectContextChars": re.compile(r'"?nonProjectContextChars"?\s*[:=]\s*(\d+)', re.IGNORECASE),
        "userTextChars": re.compile(r'"?userTextChars"?\s*[:=]\s*(\d+)', re.IGNORECASE),
    }
    for item in log_lines:
        msg = item.get("msg", "")
        for k, p in pats.items():
            m = p.search(msg)
            if not m:
                continue
            iv = to_int(m.group(1))
            if iv is not None:
                out[k] = iv
    return out


def infer_worker_system_prompt_chars(logs_dir: str, worker_id: Optional[str]) -> Optional[int]:
    if not worker_id:
        return None
    project_pat = re.compile(r'"?projectContextChars"?\s*[:=]\s*(\d+)', re.IGNORECASE)
    non_project_pat = re.compile(r'"?nonProjectContextChars"?\s*[:=]\s*(\d+)', re.IGNORECASE)
    worker_tag = f"[chat:{worker_id}]"

    for path in sorted(glob(os.path.join(logs_dir, "chat-*.log")), reverse=True):
        try:
            with open(path, "r", encoding="utf-8") as f:
                project_val = None
                non_project_val = None
                for line in f:
                    if worker_tag not in line:
                        continue
                    if project_val is None:
                        m1 = project_pat.search(line)
                        if m1:
                            project_val = to_int(m1.group(1))
                    if non_project_val is None:
                        m2 = non_project_pat.search(line)
                        if m2:
                            non_project_val = to_int(m2.group(1))
                    if project_val is not None and non_project_val is not None:
                        return project_val + non_project_val
        except OSError:
            continue
    return None


def infer_worker_context_chars(logs_dir: str, worker_id: Optional[str]) -> Tuple[Optional[int], Optional[int], Optional[str]]:
    if not worker_id:
        return None, None, None
    project_pat = re.compile(r'"?projectContextChars"?\s*[:=]\s*(\d+)', re.IGNORECASE)
    non_project_pat = re.compile(r'"?nonProjectContextChars"?\s*[:=]\s*(\d+)', re.IGNORECASE)
    worker_tag = f"[chat:{worker_id}]"

    for path in sorted(glob(os.path.join(logs_dir, "chat-*.log")), reverse=True):
        try:
            with open(path, "r", encoding="utf-8") as f:
                project_val = None
                non_project_val = None
                for line in f:
                    if worker_tag not in line:
                        continue
                    if project_val is None:
                        m1 = project_pat.search(line)
                        if m1:
                            project_val = to_int(m1.group(1))
                    if non_project_val is None:
                        m2 = non_project_pat.search(line)
                        if m2:
                            non_project_val = to_int(m2.group(1))
                    if project_val is not None and non_project_val is not None:
                        return project_val, non_project_val, f"logs.nearest[{worker_id}]"
        except OSError:
            continue
    return None, None, None


def extract_prompt_char_breakdown(
    dump: Optional[Dict[str, Any]],
    chain: Optional[Dict[str, Any]],
    log_lines: List[Dict[str, Any]],
    runtime_usage: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    merged: Dict[str, int] = {}
    if isinstance(runtime_usage, dict):
        merged.update(flatten_numeric_fields(runtime_usage, "runtime"))
    if isinstance(dump, dict):
        merged.update(flatten_numeric_fields(dump))
    if chain and chain.get("custom_row"):
        _, row = chain["custom_row"]
        data = row.get("data") if isinstance(row, dict) else None
        if isinstance(data, dict):
            merged.update(flatten_numeric_fields(data, "custom.data"))
    for k, v in extract_prompt_report_from_log_lines(log_lines).items():
        merged[f"logs.{k}"] = v

    user_chars, user_src = pick_metric_with_source(
        merged,
        [
            lambda p: 140 if p.endswith("runtime.systempromptreport.usertextchars") else 0,
            lambda p: 110 if p.endswith("runtime.promptreport.usertextchars") else 0,
            lambda p: 100 if "usertextchars" in p else 0,
            lambda p: 80 if p.endswith("requestmeta.textlen") else 0,
            lambda p: 20 if p.endswith("textlen") else 0,
        ],
    )
    system_prompt_chars, system_src = pick_metric_with_source(
        merged,
        [
            lambda p: 150 if p.endswith("runtime.systempromptreport.systemprompt.chars") else 0,
            lambda p: 120 if p.endswith("runtime.promptreport.systempromptchars") else 0,
            lambda p: 100 if "systemprompt.chars" in p else 0,
            lambda p: 90 if "system_prompt" in p and p.endswith("chars") else 0,
        ],
    )
    tools_schema_chars, tools_src = pick_metric_with_source(
        merged,
        [
            lambda p: 150 if p.endswith("runtime.systempromptreport.tools.schemachars") else 0,
            lambda p: 120 if p.endswith("runtime.promptreport.toolsschemachars") else 0,
            lambda p: 100 if "tools.schemachars" in p else 0,
            lambda p: 95 if p.endswith("injectedfiles.toolschars") else 0,
            lambda p: 80 if "tools" in p and "schemachars" in p else 0,
        ],
    )
    skills_prompt_chars, skills_src = pick_metric_with_source(
        merged,
        [
            lambda p: 150 if p.endswith("runtime.systempromptreport.skills.promptchars") else 0,
            lambda p: 120 if p.endswith("runtime.promptreport.skillspromptchars") else 0,
            lambda p: 100 if "skills.promptchars" in p else 0,
            lambda p: 85 if "skills" in p and "promptchars" in p else 0,
        ],
    )
    project_chars, project_src = pick_metric_with_source(
        merged,
        [
            lambda p: 150 if p.endswith("runtime.systempromptreport.systemprompt.projectcontextchars") else 0,
            lambda p: 120 if p.endswith("runtime.promptreport.projectcontextchars") else 0,
            lambda p: 100 if "projectcontextchars" in p else 0,
        ],
    )
    non_project_chars, non_project_src = pick_metric_with_source(
        merged,
        [
            lambda p: 150 if p.endswith("runtime.systempromptreport.systemprompt.nonprojectcontextchars") else 0,
            lambda p: 120 if p.endswith("runtime.promptreport.nonprojectcontextchars") else 0,
            lambda p: 100 if "nonprojectcontextchars" in p else 0,
        ],
    )

    if system_prompt_chars is None:
        if project_chars is not None and non_project_chars is not None:
            system_prompt_chars = project_chars + non_project_chars
            system_src = "logs.projectContextChars+nonProjectContextChars"

    if skills_prompt_chars is None:
        skills_fallback = sum_skill_md_chars(dump)
        if skills_fallback is not None:
            skills_prompt_chars = skills_fallback
            skills_src = "dump.skills.entries[*].skillMdChars(sum)"

    return {
        "user_chars": user_chars,
        "user_source": user_src,
        "system_prompt_chars": system_prompt_chars,
        "system_prompt_source": system_src,
        "tools_schema_chars": tools_schema_chars,
        "tools_schema_source": tools_src,
        "skills_prompt_chars": skills_prompt_chars,
        "skills_prompt_source": skills_src,
        "project_context_chars": project_chars,
        "project_context_source": project_src,
        "non_project_context_chars": non_project_chars,
        "non_project_context_source": non_project_src,
    }


def est_tokens(chars: Optional[int]) -> Optional[int]:
    if chars is None:
        return None
    return int(round(chars / 4.0))


def extract_tools_schema_breakdown(runtime_usage: Optional[Dict[str, Any]], dump: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "source": None,
        "total_chars": None,
        "list_chars": None,
        "entries": [],
    }

    if isinstance(runtime_usage, dict):
        spr = runtime_usage.get("systemPromptReport")
        if isinstance(spr, dict):
            tools = spr.get("tools")
            if isinstance(tools, dict):
                out["source"] = "runtime.systemPromptReport.tools"
                out["total_chars"] = to_int(tools.get("schemaChars"))
                out["list_chars"] = to_int(tools.get("listChars"))
                entries = tools.get("entries")
                if isinstance(entries, list):
                    parsed_entries: List[Dict[str, Any]] = []
                    for e in entries:
                        if not isinstance(e, dict):
                            continue
                        parsed_entries.append(
                            {
                                "name": str(e.get("name") or "unknown"),
                                "schema_chars": to_int(e.get("schemaChars")),
                                "summary_chars": to_int(e.get("summaryChars")),
                                "properties_count": to_int(e.get("propertiesCount")),
                            }
                        )
                    out["entries"] = parsed_entries
                return out

    if isinstance(dump, dict):
        injected = dump.get("injectedFiles")
        if isinstance(injected, dict):
            tools_chars = to_int(injected.get("toolsChars"))
            if tools_chars is not None:
                out["source"] = "preflight.injectedFiles.toolsChars"
                out["total_chars"] = tools_chars
                out["entries"] = [{"name": "TOOLS.md", "schema_chars": tools_chars, "summary_chars": None, "properties_count": None}]
    return out


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

    # print("\n== IDs Mapping ==")
    # print(f"runId: {run_id or 'N/A'}")
    # print(f"spawn session-id(arg): {timing.get('spawn_session_id') or 'N/A'}")
    # print(f"openclaw sessionKey: {session_key or 'N/A'}")
    # print(f"openclaw sessionId: {session_id or 'N/A'}")
    # print(f"provider/model: {status_info.get('provider') or 'N/A'} / {status_info.get('model') or 'N/A'}")

    runtime_usage_obj: Optional[Dict[str, Any]] = find_runtime_usage_by_trace(logs_dir, openclaw_root, message_id, run_id)
    normalized_usage: Dict[str, Optional[int]] = {}

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
    if timing.get("http_error_detail"):
        print(f"http error detail: {timing['http_error_detail']['msg']}")
    if timing.get("http_error_probe"):
        print(f"http error probe: {timing['http_error_probe']['msg']}")
    if timing.get("http_reply"):
        print(f"http reply: {timing['http_reply']['msg']}")
    if route.startswith("HTTP"):
        token_usage = collect_http_token_usage(log_lines, timing, chain)
        if token_usage:
            joined = " ".join(f"{k}={v}" for k, v in sorted(token_usage.items()))
            print(f"http token usage: {joined}")
            normalized = normalize_real_usage(token_usage)
            if normalized.get("cache_read_tokens") is None and runtime_usage_obj:
                raw_usage_obj = runtime_usage_obj.get("rawUsage") if isinstance(runtime_usage_obj.get("rawUsage"), dict) else {}
                cache_read = to_int(raw_usage_obj.get("cacheRead")) if isinstance(raw_usage_obj, dict) else None
                if cache_read is not None:
                    normalized["cache_read_tokens"] = cache_read
                if normalized.get("input_tokens") is None:
                    normalized["input_tokens"] = to_int(raw_usage_obj.get("input")) if isinstance(raw_usage_obj, dict) else None
            normalized_usage = normalized
            real_bits = []
            for k in [
                "prompt_tokens",
                "completion_tokens",
                "total_tokens",
                "cache_read_tokens",
                "input_tokens",
            ]:
                if normalized.get(k) is not None:
                    real_bits.append(f"{k}={normalized[k]}")
            if real_bits:
                print(
                    ANSI_BOLD_RED
                    + "real usage (normalized): "
                    + " ".join(real_bits)
                    + ANSI_RESET
                )
        else:
            print("http token usage: N/A (no usage/token fields found in logs or session custom data)")

    dump_obj: Optional[Dict[str, Any]] = None

    # print("\n== System Context ==")
    # dump_path = find_tool_schema_dump(logs_dir, message_id)
    # if not dump_path:
    #     print("tool schema dump: not found")
    # else:
    #     print(f"tool schema dump: {dump_path}")
    #     try:
    #         dump = read_json(dump_path)
    #         if isinstance(dump, dict):
    #             dump_obj = dump
    #         ctx = summarize_system_context(dump if isinstance(dump, dict) else {})
    #         print(
    #             "request meta: "
    #             f"textLen={ctx['text_len'] if ctx['text_len'] is not None else 'N/A'} "
    #             f"historyCount={ctx['history_count'] if ctx['history_count'] is not None else 'N/A'} "
    #             f"imageCount={ctx['image_count'] if ctx['image_count'] is not None else 'N/A'}"
    #         )
    #         print(
    #             "injected context chars: "
    #             f"total={ctx['injected_total_chars']} "
    #             + " ".join(f"{k}={v}" for k, v in ctx["injected_char_fields"])
    #         )
    #         print(
    #             "skills context: "
    #             f"count={ctx['skills_count'] if ctx['skills_count'] is not None else 'N/A'} "
    #             f"blockChars={ctx['skills_block_chars']}"
    #         )
    #         print(
    #             "memory preflight: "
    #             f"totalFiles={ctx['memory_total_files'] if ctx['memory_total_files'] is not None else 'N/A'} "
    #             f"referencedPaths={ctx['memory_referenced_paths']}"
    #         )
    #     except Exception as e:
    #         print(f"failed to read system context dump: {e}")

    # if runtime_usage_obj:
    #     print("runtime usage by trace: found")
    #     usage_obj = runtime_usage_obj.get("usage")
    #     if isinstance(usage_obj, dict):
    #         bits = []
    #         for k in ["prompt_tokens", "completion_tokens", "total_tokens"]:
    #             iv = to_int(usage_obj.get(k))
    #             if iv is not None:
    #                 bits.append(f"{k}={iv}")
    #         if bits:
    #             print("runtime usage by trace tokens: " + " ".join(bits))
    #     spr = runtime_usage_obj.get("systemPromptReport")
    #     if isinstance(spr, dict):
    #         sp = spr.get("systemPrompt") if isinstance(spr.get("systemPrompt"), dict) else {}
    #         tools = spr.get("tools") if isinstance(spr.get("tools"), dict) else {}
    #         skills = spr.get("skills") if isinstance(spr.get("skills"), dict) else {}
    #         sp_bits = []
    #         for k in ["chars", "projectContextChars", "nonProjectContextChars"]:
    #             iv = to_int(sp.get(k))
    #             if iv is not None:
    #                 sp_bits.append(f"systemPrompt.{k}={iv}")
    #         iv_tools = to_int(tools.get("schemaChars"))
    #         if iv_tools is not None:
    #             sp_bits.append(f"tools.schemaChars={iv_tools}")
    #         iv_skills = to_int(skills.get("promptChars"))
    #         if iv_skills is not None:
    #             sp_bits.append(f"skills.promptChars={iv_skills}")
    #         if sp_bits:
    #             print("runtime prompt report: " + " ".join(sp_bits))
    # else:
    #     print("runtime usage by trace: not found")

    print("\n== Prompt Tokens Breakdown ==")
    char_breakdown = extract_prompt_char_breakdown(dump_obj, chain, log_lines, runtime_usage_obj)
    prompt_tokens_real = normalized_usage.get("prompt_tokens") if normalized_usage else None
    if prompt_tokens_real is None and runtime_usage_obj:
        usage_obj = runtime_usage_obj.get("usage") if isinstance(runtime_usage_obj.get("usage"), dict) else {}
        prompt_tokens_real = to_int(usage_obj.get("prompt_tokens"))

    user_chars = char_breakdown.get("user_chars")
    user_src = char_breakdown.get("user_source")
    sys_chars = char_breakdown.get("system_prompt_chars")
    sys_src = char_breakdown.get("system_prompt_source")
    tool_chars = char_breakdown.get("tools_schema_chars")
    tool_src = char_breakdown.get("tools_schema_source")
    skill_chars = char_breakdown.get("skills_prompt_chars")
    skill_src = char_breakdown.get("skills_prompt_source")
    project_chars = char_breakdown.get("project_context_chars")
    project_src = char_breakdown.get("project_context_source")
    non_project_chars = char_breakdown.get("non_project_context_chars")
    non_project_src = char_breakdown.get("non_project_context_source")

    if project_chars is None or non_project_chars is None:
        ip, inp, base_src = infer_worker_context_chars(logs_dir, worker_id)
        if project_chars is None and ip is not None:
            project_chars = ip
            project_src = f"{base_src}.projectContextChars" if base_src else project_src
        if non_project_chars is None and inp is not None:
            non_project_chars = inp
            non_project_src = f"{base_src}.nonProjectContextChars" if base_src else non_project_src

    if sys_chars is None and project_chars is not None and non_project_chars is not None:
        sys_chars = project_chars + non_project_chars
        sys_src = f"{(project_src or 'N/A')}+{(non_project_src or 'N/A')}"

    print(
        "char components: "
        f"userInput={user_chars if user_chars is not None else 'N/A'} "
        f"systemPrompt={sys_chars if sys_chars is not None else 'N/A'} "
        f"tools.schemaChars={tool_chars if tool_chars is not None else 'N/A'} "
        # f"skills.promptChars={skill_chars if skill_chars is not None else 'N/A'}"
    )
    # print(
    #     "char sources: "
    #     f"userInput={user_src or 'N/A'} "
    #     f"systemPrompt={sys_src or 'N/A'} "
    #     f"tools.schemaChars={tool_src or 'N/A'} "
    #     f"skills.promptChars={skill_src or 'N/A'}"
    # )
    print(
        "systemPrompt detailed chars: "
        f"  projectContextChars={project_chars if project_chars is not None else 'N/A'} "
        f"  nonProjectContextChars={non_project_chars if non_project_chars is not None else 'N/A'}"
    )
    # print(
    #     "   systemPrompt detailed sources: "
    #     f"  projectContextChars={project_src or 'N/A'} "
    #     f"  nonProjectContextChars={non_project_src or 'N/A'}"
    # )
    if sys_chars is not None and project_chars is not None and non_project_chars is not None:
        print(
            "systemPrompt sum check: "
            f"{sys_chars} = {project_chars} + {non_project_chars}"
        )

    if dump_obj and isinstance(dump_obj, dict) and project_chars is not None:
        injected = dump_obj.get("injectedFiles")
        if isinstance(injected, dict):
            injected_total = 0
            has_injected = False
            injected_bits: List[str] = []
            for k, v in injected.items():
                if not str(k).endswith("Chars"):
                    continue
                iv = to_int(v)
                if iv is None:
                    continue
                injected_total += iv
                has_injected = True
                injected_bits.append(f"{k}={iv}")
            if has_injected:
                wrapper = project_chars - injected_total
                print(
                    "   projectContext detailed chars: "
                    f"injectedFilesChars={injected_total} "
                    f"projectWrapperChars={wrapper}"
                )
                if injected_bits:
                    print("     projectContext injected files: " + " ".join(sorted(injected_bits)))

    if non_project_chars is not None and skill_chars is not None:
        if skill_src and "skillmdchars(sum)" in skill_src.lower():
            print(
                "nonProject detailed chars: "
                f"skills.promptChars={skill_chars} "
                "otherSystemChars=N/A (skills source is SKILL.md sum, not runtime promptChars)"
            )
        else:
            other_non_project = non_project_chars - skill_chars
            print(
                "nonProject detailed chars: "
                f"skills.promptChars={skill_chars} "
                f"otherSystemChars={other_non_project}"
            )
    elif non_project_chars is not None:
        print(
            "nonProject detailed chars: "
            f"skills.promptChars={skill_chars if skill_chars is not None else 'N/A'} "
            "otherSystemChars=N/A"
        )

    if dump_obj and isinstance(dump_obj, dict):
        skills_obj = dump_obj.get("skills")
        if isinstance(skills_obj, dict):
            entries = skills_obj.get("entries")
            if isinstance(entries, list) and entries:
                skill_bits: List[Tuple[str, int]] = []
                for e in entries:
                    if not isinstance(e, dict):
                        continue
                    name = str(e.get("name") or "unknown")
                    iv = to_int(e.get("skillMdChars"))
                    if iv is None:
                        continue
                    skill_bits.append((name, iv))
                if skill_bits:
                    skill_bits.sort(key=lambda x: x[1], reverse=True)
                    print(
                        "nonProject skills(preflight SKILL.md): "
                        + " ".join(f"{name}={chars}" for name, chars in skill_bits)
                    )

    tools_breakdown = extract_tools_schema_breakdown(runtime_usage_obj, dump_obj)
    tools_total = tools_breakdown.get("total_chars")
    tools_list = tools_breakdown.get("list_chars")
    tools_entries = tools_breakdown.get("entries") if isinstance(tools_breakdown.get("entries"), list) else []
    if tools_total is not None:
        entries_sum = 0
        has_entries_sum = False
        for e in tools_entries:
            if not isinstance(e, dict):
                continue
            iv = to_int(e.get("schema_chars"))
            if iv is None:
                continue
            entries_sum += iv
            has_entries_sum = True
        print(
            "tools.schema detailed chars: "
            f"total={tools_total} "
            f"listChars={tools_list if tools_list is not None else 'N/A'} "
            f"entriesSum={entries_sum if has_entries_sum else 'N/A'}"
        )
        print(f"tools.schema detailed source: {tools_breakdown.get('source') or 'N/A'}")

        parsed: List[Tuple[str, int]] = []
        for e in tools_entries:
            if not isinstance(e, dict):
                continue
            iv = to_int(e.get("schema_chars"))
            if iv is None:
                continue
            parsed.append((str(e.get("name") or "unknown"), iv))
        parsed.sort(key=lambda x: x[1], reverse=True)
        if parsed:
            parts = [f"{name}({schema_chars})" for name, schema_chars in parsed]
            print("total tools.schema = " + " + ".join(parts))

    est_bits = []
    est_user = est_tokens(user_chars)
    est_sys = est_tokens(sys_chars)
    est_tool = est_tokens(tool_chars)
    est_skill = est_tokens(skill_chars)
    if est_user is not None:
        est_bits.append(f"userInput≈{est_user}")
    if est_sys is not None:
        est_bits.append(f"systemPrompt≈{est_sys}")
    if est_tool is not None:
        est_bits.append(f"tools.schema≈{est_tool}")
    if est_skill is not None:
        est_bits.append(f"skills≈{est_skill}")
    if est_bits:
        print(ANSI_BOLD_RED + "estimated tokens (chars/4): " + " ".join(est_bits) + ANSI_RESET)
    else:
        print("estimated tokens (chars/4): N/A")

    tracked_est_core = None
    vals_core = [v for v in [est_user, est_sys, est_tool] if v is not None]
    if vals_core:
        tracked_est_core = sum(vals_core)

    tracked_est_with_skills = None
    vals_with_skills = [v for v in [est_user, est_sys, est_tool, est_skill] if v is not None]
    if vals_with_skills:
        tracked_est_with_skills = sum(vals_with_skills)

    print(
        "prompt tokens compare(core): "
        f"tracked_est_core={tracked_est_core if tracked_est_core is not None else 'N/A'} "
        f"real_prompt_tokens={prompt_tokens_real if prompt_tokens_real is not None else 'N/A'}"
    )
    # print(
    #     "prompt tokens compare(with-skills): "
    #     f"tracked_est_with_skills={tracked_est_with_skills if tracked_est_with_skills is not None else 'N/A'} "
    #     f"real_prompt_tokens={prompt_tokens_real if prompt_tokens_real is not None else 'N/A'}"
    # )
    # if tracked_est_core is not None and prompt_tokens_real is not None:
    #     print(f"prompt tokens gap(core): {prompt_tokens_real - tracked_est_core}")
    # if tracked_est_with_skills is not None and prompt_tokens_real is not None:
    #     print(f"prompt tokens gap(with-skills): {prompt_tokens_real - tracked_est_with_skills}")

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
