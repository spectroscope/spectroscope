"""Read emission lines out of a calibrated spectrum."""

from .lines import Line, find_peaks, identify
from .calibrate import solve

__all__ = ["Line", "find_peaks", "identify", "solve"]
