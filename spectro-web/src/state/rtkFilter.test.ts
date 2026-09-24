// Card 379: the two decisions the rtk row makes without the server, as units.

import { describe, expect, it } from "vitest";
import { rtkNextValue, rtkProbeFrom } from "./rtkFilter";

describe("the rtk probe from /api/config", () => {
  it("passes the version through as the server reported it", () => {
    expect(rtkProbeFrom({ rtk: { available: true, version: "rtk 9.9.9-probe" } })).toEqual({
      available: true,
      version: "rtk 9.9.9-probe",
    });
  });

  it("reads anything else as rtk missing", () => {
    const missing = { available: false, version: "" };
    expect(rtkProbeFrom({})).toEqual(missing);
    expect(rtkProbeFrom(null)).toEqual(missing);
    expect(rtkProbeFrom({ rtk: { available: "yes", version: 3 } })).toEqual(missing);
    expect(rtkProbeFrom({ rtk: { available: false, version: "rtk 1.0.0" } })).toEqual({
      available: false,
      version: "rtk 1.0.0",
    });
  });
});

describe("a click on the rtk row", () => {
  it("flips an available switch", () => {
    expect(rtkNextValue({ on: false, available: true })).toBe("on");
    expect(rtkNextValue({ on: true, available: true })).toBe("off");
  });

  it("saves nothing when rtk is missing", () => {
    expect(rtkNextValue({ on: false, available: false })).toBeNull();
    expect(rtkNextValue({ on: true, available: false })).toBeNull();
  });
});
