"""Wavelength calibration from a reference lamp."""


def solve(pixels, wavelengths):
    """Least-squares line through (pixel, wavelength) pairs -> (slope, intercept)."""
    if len(pixels) != len(wavelengths) or len(pixels) < 2:
        raise ValueError("need at least two matched points")
    n = len(pixels)
    mean_x = sum(pixels) / n
    mean_y = sum(wavelengths) / n
    covariance = sum((x - mean_x) * (y - mean_y) for x, y in zip(pixels, wavelengths))
    variance = sum((x - mean_x) ** 2 for x in pixels)
    slope = covariance / variance
    return slope, mean_y - slope * mean_x
