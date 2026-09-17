#!/usr/bin/env python3
"""Aquilo account-manager commission packs (read-only JobWatch).

Isolated from other companies. Credentials: AQUILO_* or a dedicated
AQUILO_ENV_FILE. Never writes to BigChange.
"""

from __future__ import annotations

import sys

try:
    from scripts.aquilo_commission.run import main
except ImportError:  # python3 scripts/aquilo_staff_commission.py
    from aquilo_commission.run import main  # type: ignore

if __name__ == "__main__":
    raise SystemExit(main())
