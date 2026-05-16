#!/usr/bin/env python3
"""Clean up BigChange worksheet works descriptions for jobs completed today."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterable

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9 fallback.
    ZoneInfo = None  # type: ignore[assignment]


MARKER = "AI_WORKS_DESCRIPTION_REWRITTEN"
PUBLIC_QUESTION = "Please write a detailed description of what works have been carried out"
INTERNAL_QUESTION = "Any other comments (INTERNAL USE ONLY)"
DEFAULT_BASE_URL = "https://webservice.bigchange.com/v01/services.ashx"


QUESTION_TEXT_KEYS = (
    "Question",
    "QuestionText",
    "QuestionName",
    "QuestionTitle",
    "Name",
    "Title",
    "Label",
    "Description",
)
ANSWER_TEXT_KEYS = (
    "Answer",
    "AnswerText",
    "AnswerValue",
    "Value",
    "Text",
    "Response",
)
QUESTION_ID_KEYS = (
    "QuestionId",
    "QuestionID",
    "QuestionRef",
    "WorksheetQuestionId",
    "WorksheetQuestionID",
    "JobWorksheetQuestionId",
    "JobWorksheetQuestionID",
    "IdQuestion",
)
ANSWER_ID_KEYS = (
    "AnswerId",
    "AnswerID",
    "AnswerRef",
    "WorksheetAnswerId",
    "WorksheetAnswerID",
    "JobWorksheetAnswerId",
    "JobWorksheetAnswerID",
    "IdAnswer",
)
JOB_REF_KEYS = (
    "JobRef",
    "JobReference",
    "Reference",
    "Ref",
    "JobId",
    "JobID",
    "JobNumber",
    "JobNo",
)


@dataclass(frozen=True)
class WorksheetQuestion:
    question_id: str | None
    answer_id: str | None
    text: str
    answer: str
    raw: dict[str, Any]


@dataclass
class Summary:
    jobs_scanned: int = 0
    worksheets_updated: int = 0
    jobs_skipped: int = 0
    failures: int = 0


class ConfigError(RuntimeError):
    pass


class BigChangeError(RuntimeError):
    pass


def normalized_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def normalized_question(value: str) -> str:
    text = text_from_html(value)
    text = re.sub(r"\s+", " ", text).strip().lower()
    return text.rstrip("?:.")


def lookup(data: dict[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        if key in data:
            return data[key]

    wanted = {normalized_key(key) for key in keys}
    for key, value in data.items():
        if normalized_key(str(key)) in wanted:
            return value

    return None


def scalar_to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, dict):
        nested = lookup(value, ANSWER_TEXT_KEYS + QUESTION_TEXT_KEYS)
        if nested is not None and nested is not value:
            return scalar_to_text(nested)
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def text_from_html(value: str) -> str:
    value = html.unescape(value or "")
    value = re.sub(r"(?i)<br\s*/?>", "\n", value)
    value = re.sub(r"(?i)</p\s*>", "\n", value)
    value = re.sub(r"<[^>]+>", "", value)
    return value


def clean_text(value: str) -> str:
    text = text_from_html(value)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def compact(value: str) -> str:
    return re.sub(r"\s+", " ", clean_text(value)).strip()


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ConfigError(f"Missing required environment variable: {name}")
    return value


def today_string() -> str:
    override = os.environ.get("BIGCHANGE_TODAY")
    if override:
        dt.date.fromisoformat(override)
        return override

    timezone = os.environ.get("BIGCHANGE_TIMEZONE", "Europe/London")
    if ZoneInfo is not None:
        try:
            return dt.datetime.now(ZoneInfo(timezone)).date().isoformat()
        except Exception:
            pass
    return dt.date.today().isoformat()


class BigChangeClient:
    def __init__(self) -> None:
        auth_mode = os.environ.get("BIGCHANGE_AUTH_MODE", "api_key")
        if auth_mode != "api_key":
            raise ConfigError("BIGCHANGE_AUTH_MODE must be api_key")

        self.base_url = os.environ.get("BIGCHANGE_BASE_URL", DEFAULT_BASE_URL)
        api_key = required_env("BIGCHANGE_API_KEY")
        username = required_env("BIGCHANGE_USERNAME")
        password = required_env("BIGCHANGE_PASSWORD")
        token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        self.headers = {
            "Authorization": f"Basic {token}",
            "key": api_key,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def get(self, action: str, **params: Any) -> Any:
        return self._request("GET", "query", {"action": action, **params})

    def save_answer(self, job_ref: str, question_id: str, answer_id: str, answer: str) -> None:
        params = {
            "action": "JobSaveWorksheetAnswer",
            "JobRef": job_ref,
            "QuestionId": question_id,
            "AnswerId": answer_id,
            "Answer": answer,
        }
        transports = [
            item.strip()
            for item in os.environ.get(
                "BIGCHANGE_SAVE_TRANSPORTS", "post_query,get_query"
            ).split(",")
            if item.strip()
        ]
        errors: list[str] = []
        for transport in transports:
            try:
                payload = self._request("POST" if transport != "get_query" else "GET", transport, params)
                if response_has_error(payload):
                    errors.append(f"{transport}: {error_text(payload)}")
                    continue
                return
            except Exception as exc:  # noqa: BLE001 - all transports should be attempted.
                errors.append(f"{transport}: {exc}")

        raise BigChangeError("; ".join(errors) or "JobSaveWorksheetAnswer failed")

    def _request(self, method: str, transport: str, params: dict[str, Any]) -> Any:
        url = self.base_url
        data: bytes | None = None
        headers = dict(self.headers)

        if transport in {"query", "get_query"}:
            url = append_query(url, params)
        elif transport == "post_query":
            url = append_query(url, params)
            data = b"{}"
        elif transport == "post_json":
            data = json.dumps(params).encode("utf-8")
        else:
            raise BigChangeError(f"Unsupported transport: {transport}")

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read().decode("utf-8-sig", errors="replace")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8-sig", errors="replace")
            raise BigChangeError(f"HTTP {exc.code}: {body[:300]}") from exc
        except urllib.error.URLError as exc:
            raise BigChangeError(str(exc)) from exc

        if not raw.strip():
            return {}

        try:
            parsed: Any = json.loads(raw)
            if isinstance(parsed, str):
                try:
                    return json.loads(parsed)
                except json.JSONDecodeError:
                    return parsed
            return parsed
        except json.JSONDecodeError:
            return raw


def append_query(url: str, params: dict[str, Any]) -> str:
    separator = "&" if urllib.parse.urlparse(url).query else "?"
    return f"{url}{separator}{urllib.parse.urlencode(params)}"


def response_has_error(payload: Any) -> bool:
    if isinstance(payload, str):
        lowered = payload.lower()
        return "error" in lowered or "exception" in lowered or "invalid" in lowered
    if not isinstance(payload, dict):
        return False

    for key, value in payload.items():
        key_norm = normalized_key(str(key))
        if key_norm in {"success", "succeeded"} and value is False:
            return True
        if key_norm in {"error", "errormessage", "exception", "message"} and scalar_to_text(value).strip():
            text = scalar_to_text(value).lower()
            if "success" not in text and "saved" not in text:
                return True
    return False


def error_text(payload: Any) -> str:
    if isinstance(payload, str):
        return payload[:200]
    if isinstance(payload, dict):
        for key in ("ErrorMessage", "Error", "Message", "exception"):
            value = lookup(payload, (key,))
            if value:
                return scalar_to_text(value)[:200]
    return "unknown error"


def extract_jobs(payload: Any) -> list[dict[str, Any]]:
    candidates: list[list[dict[str, Any]]] = []

    def walk(value: Any) -> None:
        if isinstance(value, list):
            dicts = [item for item in value if isinstance(item, dict)]
            if dicts and any(job_ref(item) for item in dicts):
                candidates.append(dicts)
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)

    walk(payload)
    if not candidates and isinstance(payload, list):
        candidates.append([item for item in payload if isinstance(item, dict)])

    if not candidates:
        return []
    return max(candidates, key=len)


def job_ref(job: dict[str, Any]) -> str | None:
    value = lookup(job, JOB_REF_KEYS)
    if value is None and "Id" in job:
        value = job.get("Id")
    text = scalar_to_text(value).strip()
    return text or None


def job_type(job: dict[str, Any]) -> str:
    value = lookup(job, ("JobType", "JobTypeName", "TypeName", "Type", "JobCategory", "Category"))
    return compact(scalar_to_text(value))


def is_completed_job(job: dict[str, Any]) -> bool:
    for key, value in job.items():
        key_norm = normalized_key(str(key))
        if key_norm in {"completed", "iscompleted"} and value is True:
            return True
        if "completeddate" in key_norm or "datecompleted" in key_norm or "completiondate" in key_norm:
            if scalar_to_text(value).strip():
                return True
        if "status" in key_norm:
            text = scalar_to_text(value).strip().lower()
            if any(word in text for word in ("complete", "completed", "closed", "done")):
                return True
            if any(word in text for word in ("cancel", "open", "pending", "scheduled", "in progress")):
                return False
    return False


def extract_questions(payload: Any) -> list[WorksheetQuestion]:
    found: list[WorksheetQuestion] = []
    seen: set[tuple[str | None, str | None, str]] = set()

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            question = question_from_dict(value)
            if question:
                key = (question.question_id, question.answer_id, normalized_question(question.text))
                if key not in seen:
                    seen.add(key)
                    found.append(question)
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(payload)
    return found


def question_from_dict(data: dict[str, Any]) -> WorksheetQuestion | None:
    text = scalar_to_text(lookup(data, QUESTION_TEXT_KEYS)).strip()
    if not text:
        return None

    answer_value = lookup(data, ANSWER_TEXT_KEYS)
    answer = scalar_to_text(answer_value)
    question_id = scalar_to_text(lookup(data, QUESTION_ID_KEYS)).strip() or None
    answer_id = scalar_to_text(lookup(data, ANSWER_ID_KEYS)).strip() or None

    if question_id is None and "Id" in data and (answer_id is not None or answer_value is not None):
        question_id = scalar_to_text(data.get("Id")).strip() or None

    if answer_id is None:
        nested_answer = data.get("Answer") if isinstance(data.get("Answer"), dict) else None
        if isinstance(nested_answer, dict):
            answer_id = scalar_to_text(lookup(nested_answer, ANSWER_ID_KEYS + ("Id",))).strip() or None

    if question_id is None and answer_id is None and not answer:
        return None

    return WorksheetQuestion(question_id, answer_id, text, answer, data)


def find_question(questions: list[WorksheetQuestion], target: str) -> WorksheetQuestion | None:
    wanted = normalized_question(target)
    for question in questions:
        if normalized_question(question.text) == wanted:
            return question
    return None


def public_answer_already_rewritten(answer: str) -> bool:
    text = clean_text(answer)
    if MARKER in text:
        return True
    lowered = text.lower()
    return "repair status:" in lowered and "exceptions and caveats:" in lowered


def answer_looks_blank(answer: str) -> bool:
    return not compact(answer)


def yes_like(value: str) -> bool:
    text = compact(value).lower()
    return text in {"yes", "y", "true", "1", "required"} or text.startswith("yes ")


def no_like(value: str) -> bool:
    text = compact(value).lower()
    return text in {"no", "n", "false", "0", "none", "n/a", "na", "not applicable"}


def collect_context(job: dict[str, Any], questions: list[WorksheetQuestion]) -> dict[str, Any]:
    context: dict[str, Any] = {
        "job_type": job_type(job),
        "quote_required": "",
        "warranty": "",
        "warranty_reason": "",
        "materials": "",
        "photo_question_names": [],
    }

    photo_names: list[str] = []
    for question in questions:
        name = compact(question.text)
        answer = compact(question.answer)
        lowered = name.lower()
        if "quote" in lowered and "required" in lowered and not context["quote_required"]:
            context["quote_required"] = answer
        elif "warranty" in lowered and "reason" in lowered and not context["warranty_reason"]:
            context["warranty_reason"] = answer
        elif "warranty" in lowered and not context["warranty"]:
            context["warranty"] = answer
        elif "material" in lowered and not context["materials"] and answer and not no_like(answer):
            context["materials"] = answer

        if "photo" in lowered:
            photo_names.append(name)

    context["photo_question_names"] = photo_names
    return context


def sentence_case_after_i(text: str) -> str:
    return re.sub(r"\bI ([A-Z])", lambda match: "I " + match.group(1).lower(), text)


def convert_to_first_person(original: str) -> str:
    text = compact(original)
    replacements = (
        (r"\b[Tt]he engineer\b", "I"),
        (r"\b[Tt]he operative\b", "I"),
        (r"\b[Tt]he technician\b", "I"),
        (r"\b[Ee]ngineer\b", "I"),
        (r"\b[Oo]perative\b", "I"),
        (r"\b[Tt]echnician\b", "I"),
        (r"\b[Ww]e attended\b", "I attended"),
        (r"\b[Ww]e found\b", "I found"),
        (r"\b[Ww]e repaired\b", "I repaired"),
        (r"\b[Ww]e completed\b", "I completed"),
        (r"\b[Ww]e replaced\b", "I replaced"),
        (r"\b[Ww]e carried out\b", "I carried out"),
    )
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text)
    text = sentence_case_after_i(text)

    if re.search(r"\bI (attended|found|repaired|completed|replaced|carried|inspected|serviced|checked|cleaned|fitted|removed|adjusted|resolved|investigated|installed)\b", text, re.I):
        return ensure_terminal_punctuation(text)

    verb_match = re.match(
        r"(?i)^(attended|found|repaired|completed|replaced|carried out|inspected|serviced|checked|cleaned|fitted|removed|adjusted|resolved|investigated|installed)\b(.*)",
        text,
    )
    if verb_match:
        verb = verb_match.group(1).lower()
        rest = verb_match.group(2).strip()
        return ensure_terminal_punctuation(f"I {verb} {rest}".strip())

    return ensure_terminal_punctuation(f"I attended and completed the works described. {text}")


def ensure_terminal_punctuation(text: str) -> str:
    text = text.strip()
    if not text:
        return text
    return text if text[-1] in ".!?" else f"{text}."


def infer_repair_status(original: str, context: dict[str, Any]) -> str:
    combined = " ".join(
        compact(str(value))
        for value in (
            original,
            context.get("job_type", ""),
            context.get("quote_required", ""),
            context.get("warranty", ""),
            context.get("warranty_reason", ""),
        )
    ).lower()

    if yes_like(str(context.get("quote_required", ""))) or "quote required" in combined or "quotation" in combined:
        return "quote required"
    if "temporary" in combined or re.search(r"\btemp\b", combined):
        return "temporary repair"
    if "service" in combined and not re.search(r"\brepair|repaired|replace|replaced|fixed|resolved\b", combined):
        return "service only"
    if "inspection" in combined and not re.search(r"\brepair|repaired|replace|replaced|fixed|resolved\b", combined):
        return "inspection only"
    if re.search(r"\brepair|repaired|replace|replaced|fixed|resolved|rectified|installed|fitted\b", combined):
        return "full repair"
    return "inspection only"


def build_public_answer(original: str, context: dict[str, Any]) -> str:
    paragraph = convert_to_first_person(original)

    materials = compact(str(context.get("materials", "")))
    if materials and materials.lower() not in paragraph.lower():
        paragraph = f"{paragraph} I used the following materials: {ensure_terminal_punctuation(materials)}"

    warranty = compact(str(context.get("warranty", "")))
    warranty_reason = compact(str(context.get("warranty_reason", "")))
    if warranty and not no_like(warranty) and warranty.lower() not in paragraph.lower():
        warranty_sentence = f"Warranty noted: {warranty}"
        if warranty_reason and warranty_reason.lower() not in warranty_sentence.lower():
            warranty_sentence = f"{warranty_sentence} - {warranty_reason}"
        paragraph = f"{paragraph} {ensure_terminal_punctuation(warranty_sentence)}"

    status = infer_repair_status(original, context)
    if status in {"service only", "inspection only"}:
        status_line = (
            "Repair status: This was a completed service/inspection rather than a repair visit. "
            "No temporary repair or replacement works were carried out unless stated above."
        )
    elif status == "quote required":
        status_line = (
            "Repair status: quote required. Further remedial works require a separate quotation "
            "before they can be completed."
        )
    elif status == "temporary repair":
        status_line = (
            "Repair status: temporary repair. The works carried out were temporary and further "
            "remedial works may be required if the issue returns or deteriorates."
        )
    else:
        status_line = "Repair status: full repair."

    caveat = (
        "Exceptions and caveats: This reflects the condition of the accessible items at the time "
        "of my visit only. It does not provide an indefinite guarantee against future faults, wear, "
        "user damage, concealed defects, or issues with non-accessible components. If the issue "
        "returns or further defects are identified, additional investigation and separately quoted "
        "remedial works may be required."
    )
    return f"{paragraph}\n\n{status_line}\n\n{caveat}"


def build_internal_answer(original_public: str, existing_internal: str) -> str:
    prefix = (
        f"{MARKER}\n"
        "Original engineer wording before AI rewrite:\n"
        f"{clean_text(original_public)}"
    )
    existing = clean_text(existing_internal)
    if existing:
        return f"{prefix}\n\nPrevious internal/audit comments:\n{existing}"
    return prefix


def answers_match(actual: str, expected: str) -> bool:
    return clean_text(actual) == clean_text(expected)


def save_question_answer_and_verify(
    client: BigChangeClient,
    job_ref_value: str,
    question: WorksheetQuestion,
    new_answer: str,
    target_question_text: str,
    *,
    allow_create: bool = False,
) -> WorksheetQuestion:
    if not question.question_id:
        raise BigChangeError("question ID missing")

    answer_ids = [question.answer_id] if question.answer_id else []
    if allow_create and not answer_ids:
        answer_ids = ["0", ""]
    if not answer_ids:
        raise BigChangeError("answer ID missing")

    errors: list[str] = []
    for answer_id in answer_ids:
        try:
            client.save_answer(job_ref_value, question.question_id, answer_id, new_answer)
            refreshed = extract_questions(client.get("JobWorksheetQuestions", JobRef=job_ref_value))
            refreshed_question = find_question(refreshed, target_question_text)
            if refreshed_question is None:
                raise BigChangeError("verification question missing after save")
            if not answers_match(refreshed_question.answer, new_answer):
                raise BigChangeError("answer verification failed")
            return refreshed_question
        except Exception as exc:  # noqa: BLE001 - try all candidate answer IDs.
            errors.append(f"AnswerId={answer_id!r}: {exc}")

    raise BigChangeError("; ".join(errors))


def save_and_verify(
    client: BigChangeClient,
    job_ref_value: str,
    public_question: WorksheetQuestion,
    internal_question: WorksheetQuestion,
    new_public: str,
    new_internal: str,
    previous_internal: str,
) -> None:
    assert public_question.question_id and public_question.answer_id
    assert internal_question.question_id

    saved_internal_question: WorksheetQuestion | None = None
    try:
        saved_internal_question = save_question_answer_and_verify(
            client,
            job_ref_value,
            internal_question,
            new_internal,
            INTERNAL_QUESTION,
            allow_create=True,
        )
    except Exception:
        if compact(previous_internal):
            raise

    try:
        save_question_answer_and_verify(
            client,
            job_ref_value,
            public_question,
            new_public,
            PUBLIC_QUESTION,
        )
    except Exception:
        if saved_internal_question is not None:
            try:
                save_question_answer_and_verify(
                    client,
                    job_ref_value,
                    saved_internal_question,
                    previous_internal,
                    INTERNAL_QUESTION,
                    allow_create=True,
                )
            finally:
                raise
        raise

    refreshed = extract_questions(client.get("JobWorksheetQuestions", JobRef=job_ref_value))
    refreshed_public = find_question(refreshed, PUBLIC_QUESTION)
    refreshed_internal = find_question(refreshed, INTERNAL_QUESTION)
    if refreshed_public is None or refreshed_internal is None:
        raise BigChangeError("verification questions missing after save")
    if not answers_match(refreshed_public.answer, new_public):
        raise BigChangeError("public answer verification failed")
    if saved_internal_question is not None and not answers_match(refreshed_internal.answer, new_internal):
        raise BigChangeError("internal answer verification failed")


def run(dry_run: bool = False) -> Summary:
    client = BigChangeClient()
    today = today_string()
    jobs_payload = client.get(
        "JobsList",
        Start=today,
        End=today,
        Page=0,
        PageSize=500,
        IncludeCustomFields="true",
    )
    jobs = extract_jobs(jobs_payload)
    summary = Summary(jobs_scanned=len(jobs))

    for job in jobs:
        ref = job_ref(job)
        if not ref or not is_completed_job(job):
            summary.jobs_skipped += 1
            continue

        try:
            questions = extract_questions(client.get("JobWorksheetQuestions", JobRef=ref))
            public_question = find_question(questions, PUBLIC_QUESTION)
            internal_question = find_question(questions, INTERNAL_QUESTION)

            if public_question is None or internal_question is None:
                summary.jobs_skipped += 1
                continue
            if not all(
                (
                    public_question.question_id,
                    public_question.answer_id,
                    internal_question.question_id,
                )
            ):
                summary.jobs_skipped += 1
                continue
            if answer_looks_blank(public_question.answer):
                summary.jobs_skipped += 1
                continue
            if MARKER in clean_text(internal_question.answer):
                summary.jobs_skipped += 1
                continue
            if public_answer_already_rewritten(public_question.answer):
                summary.jobs_skipped += 1
                continue

            context = collect_context(job, questions)
            new_public = build_public_answer(public_question.answer, context)
            new_internal = build_internal_answer(public_question.answer, internal_question.answer)

            if dry_run:
                summary.worksheets_updated += 1
                continue

            save_and_verify(
                client,
                ref,
                public_question,
                internal_question,
                new_public,
                new_internal,
                internal_question.answer,
            )
            summary.worksheets_updated += 1
        except Exception:
            summary.failures += 1

    return summary


def print_summary(summary: Summary) -> None:
    print(f"jobs scanned: {summary.jobs_scanned}")
    print(f"worksheets updated: {summary.worksheets_updated}")
    print(f"jobs skipped: {summary.jobs_skipped}")
    print(f"failures: {summary.failures}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="scan and count eligible updates without saving")
    args = parser.parse_args()

    try:
        summary = run(dry_run=args.dry_run)
    except Exception:
        summary = Summary(failures=1)
        print_summary(summary)
        return 1

    print_summary(summary)
    return 1 if summary.failures else 0


if __name__ == "__main__":
    sys.exit(main())
