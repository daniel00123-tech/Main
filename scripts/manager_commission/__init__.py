"""Manager commission scorecard.

A reporting layer above the company commission engines. It does not
recalculate staff job commission.
"""

from .scorecard import assemble_report

__all__ = ["assemble_report"]
