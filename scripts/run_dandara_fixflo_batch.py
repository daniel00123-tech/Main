#!/usr/bin/env python3
"""Batch close and invoice Dandara FixFlo issues from pre-built artifact lists."""

from __future__ import annotations

import csv
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

API_KEY = os.environ.get("FIXFLO_API_KEY", "")
BASE = "https://nirvanamaintenance.fixflo.com/api/v2"
ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"
PROGRESS = ARTIFACTS / "dandara_action_progress.jsonl"
RESULTS = ARTIFACTS / "dandara_action_results.json"


def load_lines(path: Path) -> list[str]:
    return [line.strip() for line in path.read_text().splitlines() if line.strip()]


def bc_date_to_iso(value: str | None) -> str:
    text = (value or "").strip()
    if not text:
        return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    return text.replace(" ", "T", 1) if "T" not in text else text


def api(method: str, path: str, data: dict | None = None, attempts: int = 6) -> tuple[int, dict]:
    url = f"{BASE}/{path}"
    body = json.dumps(data).encode() if data is not None else None
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=90) as resp:
                raw = resp.read().decode()
                return resp.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            if exc.code in (502, 503, 429, 500) and attempt < attempts - 1:
                time.sleep(min(2**attempt, 15))
                continue
            raw = exc.read().decode()
            try:
                return exc.code, json.loads(raw)
            except Exception:
                return exc.code, {"raw": raw}
        except Exception:
            if attempt < attempts - 1:
                time.sleep(min(2**attempt, 15))
                continue
            raise
    return 500, {"Errors": ["request failed"]}


def env_errors(resp: dict) -> list[str]:
    return [str(item) for item in (resp.get("Errors") or []) if item]


def get_issue(issue_id: str) -> tuple[int, dict]:
    return api("GET", f"issue/{issue_id}")


def verify_ok(issue_id: str) -> tuple[bool, str | None, str | None, str | None]:
    code, issue = get_issue(issue_id)
    if code != 200 or issue.get("Status") != "JobCompleted":
        return False, issue.get("Status") if code == 200 else None, None, None
    code, inv = api("GET", f"issue/{issue_id}/invoicedetails")
    if code != 200:
        return False, issue.get("Status"), None, None
    ok = inv.get("InvoiceNumber") == "No Invoice Required" and bool(inv.get("Authorised"))
    return ok, issue.get("Status"), inv.get("InvoiceNumber"), inv.get("Authorised")


def submit_invoice(issue_id: str, now: str) -> tuple[int, int, list[str], str]:
    payload = {
        "InvoiceDate": now,
        "DueDate": now,
        "InvoiceNumber": "No Invoice Required",
        "Comments": "No invoice required.",
        "LineItems": [
            {
                "Type": 0,
                "Description": "No Invoice Required",
                "Quantity": 0.0,
                "UnitPrice": 0.0,
                "Net": 0.0,
                "Tax": 0.0,
                "Total": 0.0,
            }
        ],
    }
    submit = {"InvoiceNumber": "No Invoice Required", "TotalNet": 0, "TotalTax": 0, "Total": 0}
    c3, r3 = api("POST", f"issue/{issue_id}/invoicedetails", payload)
    c4, r4 = api("POST", f"issue/{issue_id}/submitinvoice", submit)
    errs = env_errors(r3) + env_errors(r4)
    msg = r4.get("Message", "") if isinstance(r4, dict) else ""
    if "cannot authorise payment" in str(msg).lower():
        errs = []
    return c3, c4, errs, msg


def append_progress(result: dict) -> None:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with PROGRESS.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(result) + "\n")


def done_ids() -> set[str]:
    if not PROGRESS.exists():
        return set()
    done: set[str] = set()
    for line in PROGRESS.read_text().splitlines():
        if line.strip():
            done.add(json.loads(line)["issue_id"])
    return done


def close_issue(issue_id: str, bc_dates: dict[str, str], now: str) -> dict:
    result: dict = {"issue_id": issue_id, "action": "close"}
    code, issue = get_issue(issue_id)
    if code != 200:
        result.update(ok=False, error=f"GET {code}")
        return result

    result["start_status"] = issue.get("Status")
    if issue.get("Status") != "JobCompleted":
        completion = {
            "JobCompletionDate": bc_date_to_iso(bc_dates.get(issue_id)),
            "JobDuration": "01:00:00",
            "FeedbackToAgent": (
                f"Works completed in BigChange ({bc_date_to_iso(bc_dates.get(issue_id, ''))[:10]})."
            ),
        }
        _, resp = api("POST", f"issue/{issue_id}/jobcompletiondetails", completion)
        errs = env_errors(resp)
        if errs:
            _, issue = get_issue(issue_id)
            result.update(ok=False, error="; ".join(errs), end_status=issue.get("Status"))
            return result

    ok, status, inv_num, auth = verify_ok(issue_id)
    if ok:
        result.update(ok=True, end_status=status, invoice_number=inv_num, authorised=auth)
        return result

    _, _, errs, msg = submit_invoice(issue_id, now)
    ok, status, inv_num, auth = verify_ok(issue_id)
    result.update(
        ok=ok,
        end_status=status,
        invoice_number=inv_num,
        authorised=auth,
        submit_msg=msg,
    )
    if not ok:
        result["error"] = "; ".join(errs) if errs else "Invoice not authorised"
    return result


def invoice_only(issue_id: str, now: str) -> dict:
    result: dict = {"issue_id": issue_id, "action": "invoice_only"}
    code, issue = get_issue(issue_id)
    if code != 200:
        result.update(ok=False, error=f"GET {code}")
        return result

    result["start_status"] = issue.get("Status")
    if issue.get("Status") != "JobCompleted":
        result.update(ok=False, error=f"Expected JobCompleted, got {issue.get('Status')}")
        return result

    ok, status, inv_num, auth = verify_ok(issue_id)
    if ok:
        result.update(ok=True, end_status=status, invoice_number=inv_num, authorised=auth, note="already done")
        return result

    _, _, errs, msg = submit_invoice(issue_id, now)
    ok, status, inv_num, auth = verify_ok(issue_id)
    result.update(ok=ok, end_status=status, invoice_number=inv_num, authorised=auth, submit_msg=msg)
    if not ok:
        result["error"] = "; ".join(errs) if errs else "Invoice not authorised"
    return result


def main() -> None:
    if not API_KEY:
        raise SystemExit("Missing FIXFLO_API_KEY environment variable")

    close_ids = load_lines(ARTIFACTS / "dandara_3mo_need_close_ids.txt")
    invoice_ids = load_lines(ARTIFACTS / "dandara_3mo_uninvoiced_ids.txt")
    bc_dates = {
        row["issue_id"]: row.get("bc_status_date", "")
        for row in csv.DictReader((ARTIFACTS / "fixflo_bc_3mo_need_close.csv").open())
    }

    already = done_ids()
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    results: list[dict] = []

    if PROGRESS.exists() and already:
        for line in PROGRESS.read_text().splitlines():
            if line.strip():
                results.append(json.loads(line))

    for issue_id in close_ids:
        if issue_id in already:
            continue
        result = close_issue(issue_id, bc_dates, now)
        results.append(result)
        append_progress(result)
        print(
            f"[close] {issue_id} {'OK' if result.get('ok') else 'FAIL'} "
            f"{result.get('end_status', '')} {result.get('error', '')[:80]}"
        )

    for issue_id in invoice_ids:
        if issue_id in already:
            continue
        result = invoice_only(issue_id, now)
        results.append(result)
        append_progress(result)
        print(
            f"[invoice] {issue_id} {'OK' if result.get('ok') else 'FAIL'} "
            f"{result.get('end_status', '')} {result.get('error', '')[:80]}"
        )

    ok = [item for item in results if item.get("ok")]
    fail = [item for item in results if not item.get("ok")]
    summary = {
        "run_at": now,
        "close_attempted": len(close_ids),
        "close_ok": sum(1 for item in results if item.get("action") == "close" and item.get("ok")),
        "close_fail": sum(1 for item in results if item.get("action") == "close" and not item.get("ok")),
        "invoice_attempted": len(invoice_ids),
        "invoice_ok": sum(1 for item in results if item.get("action") == "invoice_only" and item.get("ok")),
        "invoice_fail": sum(
            1 for item in results if item.get("action") == "invoice_only" and not item.get("ok")
        ),
        "failures": [
            {
                "issue_id": item["issue_id"],
                "action": item["action"],
                "error": item.get("error"),
                "start_status": item.get("start_status"),
                "end_status": item.get("end_status"),
            }
            for item in fail
        ],
    }

    RESULTS.write_text(json.dumps({"summary": summary, "results": results}, indent=2), encoding="utf-8")
    with (ARTIFACTS / "dandara_action_failures.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["issue_id", "action", "start_status", "end_status", "error"])
        writer.writeheader()
        for item in fail:
            writer.writerow(
                {key: item.get(key) for key in ["issue_id", "action", "start_status", "end_status", "error"]}
            )

    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
