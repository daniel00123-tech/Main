"""SMTP delivery for Nirvana commission packs. The report is the HTML body."""

from __future__ import annotations

import smtplib
from email.headerregistry import Address
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import getaddresses

from .render import GROKBOT_CID, grokbot_bytes
from .settings import STAFF, TEST_OVERRIDE_TO, ConfigError, NirvanaSettings, delivery_for


def mailbox_address(email_value: str, display_name: str = "") -> Address:
    username, domain = email_value.split("@", 1)
    return Address(display_name=display_name, username=username, domain=domain)


def parse_addresses(value: str) -> list[str]:
    return [address.lower() for _, address in getaddresses([value]) if address]


def assert_message_has_no_attachment(root: MIMEMultipart) -> None:
    for part in root.walk():
        disposition = str(part.get("Content-Disposition") or "")
        if "attachment" in disposition.lower():
            raise ConfigError("Nirvana commission email must not include attachments")


def build_message(
    *,
    settings: NirvanaSettings,
    subject: str,
    html_body: str,
    to_email: str,
    cc_email: str,
) -> tuple[MIMEMultipart, list[str]]:
    if "see attached" in html_body.lower():
        raise ConfigError("Nirvana commission email must contain the full report in the body")
    to_list = parse_addresses(to_email)
    cc_list = parse_addresses(cc_email) if cc_email else []
    if not to_list:
        raise ConfigError("Nirvana commission email has no recipient")
    if settings.test_override:
        if to_list != [TEST_OVERRIDE_TO]:
            raise ConfigError("Test override may only deliver to Daniel Dwyer")
        if cc_list:
            raise ConfigError("Test override must not CC anyone")
        staff_emails = {meta["email"].lower() for meta in STAFF.values()}
        if any(addr in staff_emails for addr in to_list + cc_list):
            raise ConfigError("Test override must not email Nirvana staff")
    root = MIMEMultipart("related")
    root["Subject"] = subject
    root["From"] = str(mailbox_address(settings.from_email, settings.from_name))
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
    assert_message_has_no_attachment(root)
    return root, recipients


def send_report_email(
    *,
    settings: NirvanaSettings,
    staff: dict[str, str],
    subject: str,
    html_body: str,
) -> tuple[str, str]:
    to_email, cc_email, prefix = delivery_for(settings, staff)
    if prefix and not subject.startswith(prefix):
        subject = f"{prefix}{subject}"
    root, recipients = build_message(
        settings=settings,
        subject=subject,
        html_body=html_body,
        to_email=to_email,
        cc_email=cc_email,
    )
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=120) as smtp:
            smtp.starttls()
            smtp.login(settings.smtp_username, settings.smtp_password)
            smtp.sendmail(settings.from_email, recipients, root.as_string())
    except Exception as exc:
        message = str(exc)
        for secret in (settings.smtp_password, settings.password, settings.api_key):
            if secret and secret in message:
                message = message.replace(secret, "***")
        raise ConfigError(f"Nirvana SMTP send failed: {type(exc).__name__}: {message}") from exc
    return to_email, cc_email
