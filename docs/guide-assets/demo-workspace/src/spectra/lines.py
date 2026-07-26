"""Peak finding and line identification."""

from dataclasses import dataclass

# Four reference lines, in nanometres, that every calibration lamp shows.
REFERENCE = {
    "H-alpha": 656.281,
    "H-beta": 486.135,
    "Na-D": 589.29,
    "Mg-b": 518.36,
}


@dataclass(frozen=True)
class Line:
    """One identified line: where it sat, and how sure we are."""

    name: str
    wavelength: float
    strength: float


def find_peaks(samples, threshold=0.15):
    """Indices of local maxima that clear `threshold`."""
    peaks = []
    for i in range(1, len(samples) - 1):
        if samples[i] >= samples[i - 1] and samples[i] > samples[i + 1]:
            if samples[i] >= threshold:
                peaks.append(i)
    return peaks


def identify(wavelength, tolerance=0.5):
    """The reference line nearest `wavelength`, or None outside the tolerance."""
    best, distance = None, tolerance
    for name, reference in REFERENCE.items():
        delta = abs(reference - wavelength)
        if delta <= distance:
            best, distance = name, delta
    return best
