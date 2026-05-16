#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
exec python3 scripts/bigchange_temp_vat_fix.py "$@"
