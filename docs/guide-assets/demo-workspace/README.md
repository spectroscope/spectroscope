# spectra

A small toolkit for reading emission lines out of a calibrated spectrum.

    python3 run_checks.py      # no dependencies
    pytest                     # if you have it

## Layout

    src/spectra/lines.py       peak finding and line identification
    src/spectra/calibrate.py   wavelength calibration from reference lamps
    tests/                     the suite
