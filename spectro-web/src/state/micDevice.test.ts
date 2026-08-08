// Card 187 step 2: which microphone, remembered — and the rule that keeps the
// picker honest when the browser is still withholding the names.

import { beforeEach, describe, expect, it } from "vitest";
import { audioConstraint, currentMicDevice, readMicDevices, setMicDevice } from "./micDevice";

const device = (deviceId: string, label: string, kind = "audioinput"): MediaDeviceInfo =>
  ({ deviceId, label, kind, groupId: "g" }) as MediaDeviceInfo;

describe("what a picker may offer", () => {
  it("keeps the inputs and drops everything else", () => {
    const choice = readMicDevices([
      device("a", "MacBook Pro Microphone (Built-in)"),
      device("b", "HD Pro Webcam C920"),
      device("c", "Studio Display Speakers", "audiooutput"),
      device("d", "FaceTime HD Camera", "videoinput"),
    ]);
    expect(choice.devices.map((d) => d.deviceId)).toEqual(["a", "b"]);
  });

  // The rule. Until permission has been granted once, every label is "" — and a
  // list of five blank rows looks broken rather than unpermitted.
  it("says the names are withheld rather than showing blank rows", () => {
    const choice = readMicDevices([device("a", ""), device("b", "")]);
    expect(choice.unnamed).toBe(true);
    expect(choice.devices).toHaveLength(2);
  });

  it("shows the list as soon as the browser names anything", () => {
    expect(readMicDevices([device("a", ""), device("b", "Loopback Audio")]).unnamed).toBe(false);
  });

  it("is not 'unnamed' when there is simply nothing", () => {
    expect(readMicDevices([]).unnamed).toBe(false);
  });
});

describe("the constraint handed to getUserMedia", () => {
  it("asks for nothing in particular when nothing was chosen", () => {
    expect(audioConstraint(null)).toBe(true);
  });

  // `ideal`, never `exact`. A remembered device that has since been unplugged
  // would fail the whole call under `exact` and take the microphone away over a
  // preference.
  it("wishes for the remembered device rather than demanding it", () => {
    expect(audioConstraint("abc")).toEqual({ deviceId: { ideal: "abc" } });
  });
});

describe("remembering the choice", () => {
  beforeEach(() => setMicDevice(null));

  it("holds what was picked", () => {
    setMicDevice("abc");
    expect(currentMicDevice()).toBe("abc");
  });

  it("forgets on null, which is 'let the system decide' and not 'device null'", () => {
    setMicDevice("abc");
    setMicDevice(null);
    expect(currentMicDevice()).toBeNull();
  });
});
