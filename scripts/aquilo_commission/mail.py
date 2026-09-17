"""Preview-only SMTP delivery for Aquilo commission packs."""

from __future__ import annotations

import smtplib
from email.headerregistry import Address
from email.mime.application import MIMEApplication
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import getaddresses

from .render import GROKBOT_CID, grokbot_bytes
from .settings import (
    PREVIEW_CC_ALLOWLIST,
    PREVIEW_TO_ALLOWLIST,
    AquiloSettings,
    ConfigError,
)


def mailbox_address(email_value: str, display_name: str = "") -> Address:
    username, domain = email_value.split("@", 1)
    return Address(display_name=display_name, username=username, domain=domain)


def parse_addresses(value: str) -> list[str]:
    return [address.lower() for _, address in getaddresses([value]) if address]


def assert_preview_recipients(settings: AquiloSettings) -> tuple[list[str], list[str]]:
    to_list = parse_addresses(settings.to_email)
    cc_list = parse_addresses(settings.cc_email) if settings.cc_email else []
    if settings.go_live:
        if not to_list:
            raise ConfigError("Go-live send requires SMTP_TO_EMAIL")
        return to_list, cc_list
    bad_to = [addr for addr in to_list if addr not in PREVIEW_TO_ALLOWLIST]
    bad_cc = [addr for addr in cc_list if addr not in PREVIEW_CC_ALLOWLIST]
    if bad_to or bad_cc:
        raise ConfigError(
            "Preview packs may only go to the configured preview inboxes. "
            "Set AQUILO_COMMISSION_GO_LIVE=1 before sending to staff."
        )
    if not to_list:
        raise ConfigError("SMTP_TO_EMAIL is required")
    return to_list, cc_list


def send_preview_email(
    *,
    settings: AquiloSettings,
    subject: str,
    html_body: str,
    attachment_html: str,
    attachment_name: str,
) -> None:
    to_list, cc_list = assert_preview_recipients(settings)
    root = MIMEMultipart("related")
    root["Subject"] = subject
    root["From"] = str(mailbox_address(settings.from_email, settings.from_name))
    root["To"] = ", ".join(to_list)
    recipients = list(to_list)
    if cc_list:
        root["Cc"] = ", ".join(cc_list)
        recipients.extend(cc_list)

    alt = MIMEMultipart("alternative")
    root.attach(alt)
    alt.attach(MIMEText(html_body, "html", "utf-8"))

    icon = MIMEImage(grokbot_bytes(), _subtype="jpeg")
    icon.add_header("Content-ID", f"<{GROKBOT_CID}>")
    icon.add_header("Content-Disposition", "inline", filename="grokbot.jpg")
    root.attach(icon)

    attachment = MIMEApplication(attachment_html.encode("utf-8"), _subtype="html")
    attachment.add_header("Content-Disposition", "attachment", filename=attachment_name)
    root.attach(attachment)

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=120) as smtp:
        smtp.starttls()
        smtp.login(settings.smtp_username, settings.smtp_password)
        smtp.sendmail(settings.from_email, recipients, root.as_string())
