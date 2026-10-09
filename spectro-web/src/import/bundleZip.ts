// Card 473: the reader for a session bundle (<id>.spectro.zip). The server
// writes it with java.util.zip, deflated, with data descriptors after each
// entry, so the local headers carry no sizes and the central directory is the
// only place that does. This reader walks the central directory, inflates
// with the browser's own DecompressionStream, and checks every entry against
// its CRC-32, so a damaged download is refused rather than half-imported.
//
// Stored (method 0) and deflated (method 8) entries are read. Encrypted
// entries and ZIP64 archives are refused: the server never writes them, and a
// bundle over 4 GB is past every ceiling the recorders keep.

/** One entry of the archive: its name and its bytes, exactly as zipped. */
export interface ZipEntryBytes {
  name: string;
  bytes: Uint8Array;
}

const END_OF_CENTRAL = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** How a long read shares the thread: the same options the wire reader takes. */
export interface SliceOptions {
  /** Called after each slice with the bytes done so far and the total. */
  onProgress?: (done: number, total: number) => void;
  /** How long one slice may hold the thread, in milliseconds. Default 12. */
  sliceMs?: number;
  /** The clock; performance.now unless a test moves it by hand. */
  now?: () => number;
}

/** Bytes checked between two looks at the clock. */
const CHUNK = 256 * 1024;

const yieldToTheBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A slice clock over a run of byte work: `tick(n)` counts n bytes done and,
 * once the slice has used its budget, reports progress and hands the thread
 * back before the next slice starts.
 *
 * @param total   the bytes the whole run will do
 * @param options budget, clock and progress
 * @param offset  bytes already done before this run, added to each report
 */
export function sliceClock(
  total: number,
  options: SliceOptions,
  offset = 0,
): { tick: (n: number) => Promise<void>; done: () => number } {
  const budget = options.sliceMs ?? 12;
  const now = options.now ?? (() => performance.now());
  let done = 0;
  let started = now();
  return {
    async tick(n: number) {
      done += n;
      if (now() - started < budget) return;
      options.onProgress?.(offset + done, total);
      await yieldToTheBrowser();
      started = now();
    },
    done: () => done,
  };
}

async function crc32(bytes: Uint8Array, tick: (n: number) => Promise<void>): Promise<number> {
  let c = 0xffffffff;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK);
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    await tick(end - start);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The end-of-central-directory record, searched from the back: it is at
 *  least 22 bytes and at most 22 plus a 65535-byte comment from the end. */
function endRecord(view: DataView): number {
  const last = view.byteLength - 22;
  const first = Math.max(0, last - 0xffff);
  for (let at = last; at >= first; at--) {
    if (view.getUint32(at, true) === END_OF_CENTRAL) return at;
  }
  throw new Error("not a zip archive");
}

/**
 * Every file entry of a zip archive, in central-directory order. The
 * checksum runs in slices (card 473 review: a 50 MB wire entry held the
 * thread for about 190 ms in one go).
 *
 * @param data    the archive's bytes
 * @param options slicing and progress; progress counts the entries'
 *                uncompressed bytes
 * @return the entries; a directory entry (a name ending in "/") is skipped
 * @throws when the bytes are not a zip, an entry is encrypted, uses a method
 *         other than stored or deflated, needs ZIP64, or fails its checksum
 */
export async function readZip(data: Uint8Array, options: SliceOptions = {}): Promise<ZipEntryBytes[]> {
  if (data.byteLength < 22) throw new Error("not a zip archive");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const end = endRecord(view);
  const count = view.getUint16(end + 10, true);
  const cdOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("ZIP64 archives are not read");
  const names = new TextDecoder("utf-8", { fatal: false });
  const out: ZipEntryBytes[] = [];
  const total = totalSize(view, cdOffset, count);
  const clock = sliceClock(total, options);
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > data.byteLength || view.getUint32(at, true) !== CENTRAL) {
      throw new Error("not a zip archive: the central directory is damaged");
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = names.decode(data.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if ((flags & 1) !== 0) throw new Error(`${name}: encrypted entries are not read`);
    if (packed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64 archives are not read");
    }
    if (view.getUint32(localOffset, true) !== LOCAL) throw new Error(`${name}: the entry header is damaged`);
    const dataStart =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const body = data.subarray(dataStart, dataStart + packed);
    let bytes: Uint8Array;
    if (method === 0) bytes = body;
    else if (method === 8) bytes = await inflateRaw(body);
    else throw new Error(`${name}: compression method ${method} is not read`);
    if (bytes.length !== size || (await crc32(bytes, clock.tick)) !== crc) {
      throw new Error(`${name}: the entry does not match its checksum`);
    }
    out.push({ name, bytes });
  }
  options.onProgress?.(total, total);
  return out;
}

/** The sum of the entries' uncompressed sizes, read off the central
 *  directory without touching an entry; 0 when the directory is damaged
 *  (the walk proper then says why). */
function totalSize(view: DataView, cdOffset: number, count: number): number {
  let total = 0;
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > view.byteLength || view.getUint32(at, true) !== CENTRAL) return 0;
    total += view.getUint32(at + 24, true);
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return total;
}
