from spectra import find_peaks, identify, solve


def test_find_peaks_ignores_noise_below_the_threshold():
    assert find_peaks([0.0, 0.9, 0.0, 0.05, 0.0]) == [1]


def test_identify_snaps_to_the_nearest_reference_line():
    assert identify(656.4) == "H-alpha"
    assert identify(500.0) is None


def test_solve_recovers_a_known_linear_dispersion():
    slope, intercept = solve([0, 100, 200], [400.0, 450.0, 500.0])
    assert round(slope, 6) == 0.5
    assert round(intercept, 6) == 400.0
