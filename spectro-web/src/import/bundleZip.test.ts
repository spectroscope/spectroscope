// Card 473: the bundle a stored session exports (GET /api/sessions/{id}/bundle)
// is read back in the browser. The fixture under fixtures/bundle-473/ was
// written by the REAL recorders and zipped with java.util.zip the way
// SessionBundle.write zips (the generator is kept in the card's evidence
// folder), so this reads what the server sends, not what a test imagines.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readZip } from "./bundleZip";

const dir = fileURLToPath(new URL("./fixtures/bundle-473/", import.meta.url));
const zipName = readdirSync(dir).find((n) => n.endsWith(".spectro.zip"));
if (zipName === undefined) throw new Error("the bundle fixture is missing");
const id = zipName.slice(0, -".spectro.zip".length);
const bytesOf = (name: string): Uint8Array => new Uint8Array(readFileSync(dir + name));

/** A zip written by hand: local headers, central directory, end record. */
function handZip(files: { name: string; data: Uint8Array; deflate: boolean }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const f of files) {
    const name = enc.encode(f.name);
    const body = f.deflate ? new Uint8Array(deflateRawSync(f.data)) : f.data;
    const crc = crc32(f.data) >>> 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, f.deflate ? 8 : 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, f.deflate ? 8 : 0, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("readZip", () => {
  it("reads the server's bundle back byte for byte, in zip order", async () => {
    const entries = await readZip(bytesOf(zipName));
    expect(entries.map((e) => e.name)).toEqual([`${id}.jsonl`, `${id}.llm.jsonl`, `${id}.browser.jsonl`]);
    for (const entry of entries) {
      // Byte equality, not string equality: the session carries non-ASCII
      // text, and a reader that decoded and re-encoded would still pass a
      // string compare.
      expect(Buffer.from(entry.bytes).equals(Buffer.from(bytesOf(entry.name))), entry.name).toBe(true);
    }
  });

  it("reads a stored entry and a deflated one from the same archive", async () => {
    const a = new TextEncoder().encode('{"type":"run_start"}\n');
    const b = new TextEncoder().encode("grüße ✓\n".repeat(50));
    const entries = await readZip(
      handZip([
        { name: "s.jsonl", data: a, deflate: false },
        { name: "children/c1.jsonl", data: b, deflate: true },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual(["s.jsonl", "children/c1.jsonl"]);
    expect(Buffer.from(entries[0].bytes).equals(Buffer.from(a))).toBe(true);
    expect(Buffer.from(entries[1].bytes).equals(Buffer.from(b))).toBe(true);
  });

  it("refuses an entry whose bytes do not match its checksum", async () => {
    const zip = handZip([{ name: "s.jsonl", data: new TextEncoder().encode("abc\n"), deflate: false }]);
    zip[30 + "s.jsonl".length] ^= 0xff; // flip the first data byte
    await expect(readZip(zip)).rejects.toThrow(/checksum/);
  });

  it("checks a large entry in slices and says how far it got", async () => {
    // A 50 MB wire inside a bundle: the checksum runs over every byte, and a
    // checksum in one go held the thread for the whole entry. A clock that
    // moves 5 ms per reading makes the count of slices a property of how
    // often the reader looks.
    const big = new Uint8Array(4 * 1024 * 1024).fill(0x61);
    let clock = 0;
    const reports: [number, number][] = [];
    const entries = await readZip(handZip([{ name: "w.llm.jsonl", data: big, deflate: false }]), {
      now: () => (clock += 5),
      sliceMs: 12,
      onProgress: (done, total) => reports.push([done, total]),
    });
    expect(Buffer.from(entries[0].bytes).equals(Buffer.from(big))).toBe(true);
    expect(reports.length).toBeGreaterThanOrEqual(4);
    expect(reports[reports.length - 1]).toEqual([big.length, big.length]);
  });

  it("refuses what is not a zip", async () => {
    await expect(readZip(new TextEncoder().encode('{"type":"run_start"}\n'))).rejects.toThrow(/not a zip/);
  });
});
