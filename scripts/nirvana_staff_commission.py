#!/usr/bin/env python3
"""Nirvana account-manager commission packs (read-only JobWatch).

Isolated from other companies. Credentials: NIRVANA_* or NIRVANA_ENV_FILE.
Never writes to BigChange. The full report is the email body.
"""

from __future__ import annotations

try:
    from scripts.nirvana_commission.run import main
except ImportError:  # python3 scripts/nirvana_staff_commission.py
    from nirvana_commission.run import main  # type: ignore

if __name__ == "__main__":
    raise SystemExit(main())
