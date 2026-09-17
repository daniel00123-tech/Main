#!/usr/bin/env python3
"""Send FixFlo appointment confirmation comments for pre-identified IS list."""

from __future__ import annotations

import csv
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

API_KEY = os.environ.get("FIXFLO_API_KEY", "")
BASE = "https://nirvanamaintenance.fixflo.com/api/v2"
ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"
INPUT = ARTIFACTS / "fixflo_bc_15d_confirm_candidates.csv"
PROGRESS = ARTIFACTS / "fixflo_bc_15d_confirm_send_progress.jsonl"
RESULTS = ARTIFACTS / "fixflo_bc_15d_confirm_send_results.json"


def message_for(date: str) -> str:
    return (
        "Hi,\n"
        f"Just a quick note to confirm your appointment on {date}, between 8:00 am and 5:00 pm.\n"
        "Please let us know if this still works for you or if you need to rearrange."
    )


def api(method: str, path: str, data: dict | None = None) -> tuple[int, dict]:
    body = json.dumps(data).encode() if data is not None else None
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    for attempt in range(6):
        try:
            req = urllib.request.Request(f"{BASE}/{path}", data=body, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=90) as resp:
                raw = resp.read().decode()
                return resp.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            if exc.code in (502, 503, 429, 500) and attempt < 5:
                time.sleep(min(2**attempt, 15))
                continue
            raw = exc.read().decode()
            try:
                return exc.code, json.loads(raw)
            except Exception:
                return exc.code, {"raw": raw}
        except Exception:
            if attempt < 5:
                time.sleep(min(2**attempt, 15))
                continue
            raise
    return 500, {"Errors": ["request failed"]}


def done_ids() -> set[str]:
    if not PROGRESS.exists():
        return set()
    return {json.loads(line)["issue_id"] for line in PROGRESS.read_text().splitlines() if line.strip()}


def append_progress(row: dict) -> None:
    with PROGRESS.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def send_row(row: dict) -> dict:
    issue_id = row["is"]
    date = row.get("confirm_date") or ""
    recipient = row.get("recipient") or "Agent"
    if recipient != "Tenant":
        recipient = "Agent"

    result = {
        "issue_id": issue_id,
        "jb": row.get("jb"),
        "recipient": recipient,
        "confirm_date": date,
        "contact": row.get("contact"),
    }

    payload = {
        "Message": message_for(date),
        "CommentToEntityType": [recipient],
    }
    code, resp = api("POST", f"issue/{issue_id}/comment", payload)
    entity = resp.get("Entity") if isinstance(resp, dict) else None
    errors = resp.get("Errors") if isinstance(resp, dict) else None

    if code in (200, 201) and entity and not errors:
        result.update(
            ok=True,
            comment_id=entity.get("Id"),
            sent_to=entity.get("CommentToEntityType"),
            comment_sent=entity.get("CommentSent"),
        )
    else:
        result.update(ok=False, http=code, error=str(errors or resp)[:300])
    return result


def main() -> None:
    if not API_KEY:
        raise SystemExit("Missing FIXFLO_API_KEY environment variable")

    rows = list(csv.DictReader(INPUT.open()))
    already = done_ids()
    results: list[dict] = []

    if PROGRESS.exists() and already:
        for line in PROGRESS.read_text().splitlines():
            if line.strip():
                results.append(json.loads(line))

    for index, row in enumerate(rows, 1):
        issue_id = row["is"]
        if issue_id in already:
            continue
        result = send_row(row)
        results.append(result)
        append_progress(result)
        mark = "OK" if result.get("ok") else "FAIL"
        print(f"[{index}/{len(rows)}] {issue_id} -> {result.get('recipient')} {mark} {result.get('error', '')[:60]}")

    ok = [r for r in results if r.get("ok")]
    fail = [r for r in results if not r.get("ok")]
    summary = {
        "attempted": len(rows),
        "ok": len(ok),
        "fail": len(fail),
        "tenant_sent": sum(1 for r in ok if r.get("recipient") == "Tenant"),
        "agent_sent": sum(1 for r in ok if r.get("recipient") == "Agent"),
        "failures": fail,
    }
    RESULTS.write_text(json.dumps({"summary": summary, "results": results}, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
