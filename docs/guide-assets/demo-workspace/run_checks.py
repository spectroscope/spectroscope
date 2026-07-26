"""Run the suite without any dependency but the standard library."""

import sys

sys.path.insert(0, "src")

from spectra import find_peaks, identify, solve  # noqa: E402

CHECKS = []


def check(name):
    def wrap(fn):
        CHECKS.append((name, fn))
        return fn
    return wrap


@check("find_peaks ignores noise below the threshold")
def _peaks():
    assert find_peaks([0.0, 0.9, 0.0, 0.05, 0.0]) == [1]


@check("identify snaps to the nearest reference line")
def _identify():
    assert identify(656.4) == "H-alpha"
    assert identify(500.0) is None


@check("solve recovers a known linear dispersion")
def _solve():
    slope, intercept = solve([0, 100, 200], [400.0, 450.0, 500.0])
    assert round(slope, 6) == 0.5
    assert round(intercept, 6) == 400.0


if __name__ == "__main__":
    print("spectra 0.2.0")
    for name, fn in CHECKS:
        fn()
        print(f"  ok   {name}")
    print(f"\n{len(CHECKS)} checks passed")
