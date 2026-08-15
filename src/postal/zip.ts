/**
 * Just enough ZIP to read the postal-code archives, with no dependency.
 *
 * Workers have no ZIP reader, and the monthly update must not add one for two
 * files of a few hundred bytes. The archive is located through the central
 * directory (the authoritative record of what an archive contains: the local
 * header may legally omit the sizes) and inflated with the platform's own
 * `DecompressionStream("deflate-raw")` — a ZIP member is a raw deflate stream
 * with no zlib wrapper, which is exactly what "deflate-raw" expects.
 *
 * `scripts/postal-codes.mjs` repeats this parsing against `zlib.inflateRawSync`
 * because it runs in Node, outside the Worker's module graph and without a
 * build step. The two must stay in agreement.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const data = view(bytes);
  // The record is last, but a trailing comment of up to 65,535 bytes may follow
  // it, so the tail is scanned backwards for the signature.
  const earliest = Math.max(0, bytes.byteLength - (22 + 0xffff));
  for (let offset = bytes.byteLength - 22; offset >= earliest; offset -= 1) {
    if (data.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error("not a ZIP archive: no end-of-central-directory record");
}

export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const data = view(bytes);
  const eocd = findEndOfCentralDirectory(bytes);
  const count = data.getUint16(eocd + 10, true);
  let offset = data.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.byteLength || data.getUint32(offset, true) !== CENTRAL_FILE_HEADER) {
      throw new Error("corrupt ZIP archive: bad central directory entry");
    }
    const method = data.getUint16(offset + 10, true);
    const compressedSize = data.getUint32(offset + 20, true);
    const nameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const localHeaderOffset = data.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    entries.push({ name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryBytes(bytes: Uint8Array, entry: ZipEntry): Uint8Array<ArrayBuffer> {
  const data = view(bytes);
  const header = entry.localHeaderOffset;
  if (header + 30 > bytes.byteLength || data.getUint32(header, true) !== LOCAL_FILE_HEADER) {
    throw new Error(`corrupt ZIP archive: bad local header for ${entry.name}`);
  }
  // Name and extra lengths are read from the local header rather than the
  // central directory: the two are allowed to differ, and only the local one
  // describes where this member's bytes actually start.
  const nameLength = data.getUint16(header + 26, true);
  const extraLength = data.getUint16(header + 28, true);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) throw new Error(`truncated ZIP member ${entry.name}`);
  // Copied rather than viewed: the member has to be handed to Response as a
  // body, which requires a view over a plain ArrayBuffer. The monthly archives
  // are a few hundred bytes, so the copy costs nothing.
  return new Uint8Array(bytes.subarray(start, end));
}

/** UTF-8 text of one member. The postal archives are published UTF-8 encoded. */
export async function readZipEntryText(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  const compressed = entryBytes(bytes, entry);
  if (entry.method === STORED) return new TextDecoder().decode(compressed);
  if (entry.method !== DEFLATED) {
    throw new Error(`unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  }

  const stream = new Response(compressed).body;
  if (stream === null) throw new Error(`empty ZIP member ${entry.name}`);
  return await new Response(stream.pipeThrough(new DecompressionStream("deflate-raw"))).text();
}

/** Text of the single CSV the postal archives contain. */
export async function readZipCsvText(bytes: Uint8Array): Promise<string> {
  const entries = listZipEntries(bytes);
  const csv = entries.find((entry) => entry.name.toLowerCase().endsWith(".csv")) ?? entries[0];
  if (csv === undefined) throw new Error("ZIP archive contains no files");
  return await readZipEntryText(bytes, csv);
}
