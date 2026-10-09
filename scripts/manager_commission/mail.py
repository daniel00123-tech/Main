"""Preview-only delivery for the manager scorecard. The HTML body is the report."""

from __future__ import annotations

import json
import smtplib
import socket
from email.headerregistry import Address
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import getaddresses
from pathlib import Path

from scripts.aquilo_commission.settings import STAFF as AQUILO_STAFF
from scripts.nirvana_commission.render import GROKBOT_CID, grokbot_bytes
from scripts.nirvana_commission.settings import STAFF as NIRVANA_STAFF

from .config import STAFF_INBOX_DOMAINS, ConfigError, cc_domain, cc_domain_problem
from .models import ManagerReport

LEDGER = Path("/tmp/manager_commission/send-ledger.json")


def subject_for(report: ManagerReport) -> str:
    return f"Grokbot Manager Commission Scorecard — {report.heading} — {report.month_label}"


def parse_addresses(value: str) -> list[str]:
    return [address.lower() for _, address in getaddresses([value]) if address]


def staff_inboxes() -> set[str]:
    emails = {str(meta["email"]).lower() for meta in NIRVANA_STAFF.values()}
    emails.update(str(meta["email"]).lower() for meta in AQUILO_STAFF.values())
    return emails


def assert_not_staff(to_email: str, cc_email: str) -> None:
    blocked = staff_inboxes()
    for address in parse_addresses(to_email) + (parse_addresses(cc_email) if cc_email else []):
        domain = cc_domain(address)
        if address in blocked or domain in STAFF_INBOX_DOMAINS:
            raise ConfigError("Manager scorecard must not be sent to a staff inbox")


def assert_cc_can_receive(cc_email: str) -> None:
    problem = cc_domain_problem(cc_email)
    if problem:
        raise ConfigError(problem)
    if not cc_email:
        return
    domain = cc_domain(cc_email)
    try:
        socket.getaddrinfo(domain, 25)
    except socket.gaierror as exc:
        raise ConfigError(f"CC domain {domain} does not resolve. Delivery stays off.") from exc


def period_already_sent(period_id: str, ledger: Path = LEDGER) -> bool:
    if not ledger.is_file():
        return False
    payload = json.loads(ledger.read_text(encoding="utf-8"))
    sent = payload.get("sent") if isinstance(payload, dict) else None
    return isinstance(sent, list) and period_id in sent


def record_sent(period_id: str, ledger: Path = LEDGER) -> None:
    existing: list[str] = []
    if ledger.is_file():
        payload = json.loads(ledger.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and isinstance(payload.get("sent"), list):
            existing = [str(item) for item in payload["sent"]]
    if period_id not in existing:
        existing.append(period_id)
    ledger.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_text(json.dumps({"sent": existing}, indent=2), encoding="utf-8")


def build_message(
    *,
    from_email: str,
    from_name: str,
    to_email: str,
    cc_email: str,
    subject: str,
    html_body: str,
) -> tuple[MIMEMultipart, list[str]]:
    if "see attached" in html_body.lower():
        raise ConfigError("Manager scorecard email must contain the full report in the body")
    assert_not_staff(to_email, cc_email)
    to_list = parse_addresses(to_email)
    cc_list = parse_addresses(cc_email) if cc_email else []
    if not to_list:
        raise ConfigError("Manager scorecard has no recipient")
    root = MIMEMultipart("related")
    root["Subject"] = subject
    root["From"] = str(Address(display_name=from_name, username=from_email.split("@", 1)[0], domain=from_email.split("@", 1)[1]))
    root["To"] = ", ".join(to_list)
    recipients = list(to_list)
    if cc_list:
        root["Cc"] = ", ".join(cc_list)
        recipients.extend(cc_list)
    alternative = MIMEMultipart("alternative")
    root.attach(alternative)
    alternative.attach(MIMEText(html_body, "html", "utf-8"))
    icon = MIMEImage(grokbot_bytes(), _subtype="jpeg")
    icon.add_header("Content-ID", f"<{GROKBOT_CID}>")
    icon.add_header("Content-Disposition", "inline", filename="grokbot.jpg")
    root.attach(icon)
    for part in root.walk():
        disposition = str(part.get("Content-Disposition") or "")
        if "attachment" in disposition.lower():
            raise ConfigError("Manager scorecard email must not include attachments")
    return root, recipients


def send_report(
    report: ManagerReport,
    html_body: str,
    *,
    smtp_host: str,
    smtp_port: int,
    smtp_username: str,
    smtp_password: str,
    from_email: str,
    from_name: str,
    ledger: Path = LEDGER,
) -> None:
    if report.delivery_mode != "approved":
        raise ConfigError("Manager scorecard is preview-only until delivery is explicitly approved")
    assert_cc_can_receive(report.cc_email)
    if period_already_sent(report.period_id, ledger):
        raise ConfigError(f"Manager scorecard {report.period_id} was already sent")
    root, recipients = build_message(
        from_email=from_email,
        from_name=from_name,
        to_email=report.manager_email,
        cc_email=report.cc_email,
        subject=subject_for(report),
        html_body=html_body,
    )
    try:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=120) as smtp:
            smtp.starttls()
            smtp.login(smtp_username, smtp_password)
            smtp.sendmail(from_email, recipients, root.as_string())
    except ConfigError:
        raise
    except Exception as exc:
        message = str(exc)
        for secret in (smtp_password,):
            if secret and secret in message:
                message = message.replace(secret, "***")
        raise ConfigError(f"Manager scorecard SMTP send failed: {type(exc).__name__}") from exc
    record_sent(report.period_id, ledger)
