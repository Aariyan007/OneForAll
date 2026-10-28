import { crc32, inflateRawSync } from "node:zlib";
import type { ArchiveLimits } from "./limits";

// A strict, in-memory ZIP reader for uploaded source archives. Pure: no filesystem, no network, nothing is extracted
// to disk. It reads the central directory, cross-checks every local header, and refuses anything it cannot validate
// instead of guessing:
//   * ZIP64, multi-disk, encrypted entries, compression other than STORE (0) / DEFLATE (8);
//   * data before or after the archive, malformed records, overlapping entries;
//   * special files (devices, pipes, sockets) and non-UTF-8 names without the UTF-8 flag; symbolic links are skipped
//     and counted, never followed;
//   * sizes beyond the limits, suspicious compression ratios, wrong CRC-32 or length after decompression.
// Decompression is bounded by the declared size (`maxOutputLength`), so a lying header cannot expand without limit.

export class ArchiveError extends Error {
  // `message` is safe to show to the user: it never contains server paths or internal state.
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

export type ZipFile = {
  name: string; // raw entry name, decoded (not yet normalized)
  size: number; // uncompressed size from the central directory (verified when the data is read)
  data: Buffer | null; // null when the file was skipped for size, or is a symbolic link
  link?: true; // a symbolic link: its header is validated, but it is never decompressed, followed or recorded
};

export type ZipArchive = { files: ZipFile[]; directories: number; comment: string };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const DATA_DESCRIPTOR = 0x08074b50;
const UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeName(bytes: Buffer, utf8Flag: boolean): string {
  if (!utf8Flag) {
    // Without the UTF-8 flag the name is in a legacy code page; only plain ASCII is unambiguous.
    for (const byte of bytes) if (byte >= 0x80) throw new ArchiveError("The archive uses file names that are not UTF-8.");
    return bytes.toString("latin1");
  }
  try {
    return utf8.decode(bytes);
  } catch {
    throw new ArchiveError("The archive contains a file name that is not valid UTF-8.");
  }
}

export function readZip(buf: Buffer, limits: ArchiveLimits, now: () => number = Date.now): ZipArchive {
  const started = now();
  const malformed = () => new ArchiveError("The file is not a valid ZIP archive.");
  if (buf.length < 22) throw malformed();

  // End of central directory: the record must end exactly at the end of the file (no trailing data).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw malformed();

  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const comment = buf.subarray(eocd + 22, buf.length).toString("latin1");

  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) throw new ArchiveError("ZIP64 archives are not supported.");
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ArchiveError("ZIP64 archives are not supported.");
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== entries) throw new ArchiveError("Multi-part ZIP archives are not supported.");
  // The central directory must end exactly where the end record starts (no gaps, no hidden data).
  if (cdOffset + cdSize !== eocd) throw malformed();
  if (entries > limits.maxEntries) throw new ArchiveError(`The archive has more than ${limits.maxEntries} entries.`);

  const files: ZipFile[] = [];
  const ranges: { start: number; end: number; descriptor: boolean }[] = [];
  let directories = 0;
  let total = 0;
  let p = cdOffset;

  for (let k = 0; k < entries; k++) {
    if (now() - started > limits.maxReadMillis) throw new ArchiveError("The archive took too long to read.");
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CENTRAL) throw malformed();
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const diskStart = buf.readUInt16LE(p + 34);
    const externalAttributes = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const next = p + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) throw malformed();
    if (nameLength === 0) throw malformed();
    if (nameLength > limits.maxNameBytes) throw new ArchiveError(`The archive contains a path longer than ${limits.maxNameBytes} bytes.`);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLength);
    p = next;

    if (flags & 0x0001 || flags & 0x0040) throw new ArchiveError("Encrypted ZIP archives are not supported.");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ArchiveError("ZIP64 archives are not supported.");
    }
    if (diskStart !== 0) throw new ArchiveError("Multi-part ZIP archives are not supported.");
    const name = decodeName(nameBytes, (flags & 0x0800) !== 0);
    if (name.includes("\u0000")) throw new ArchiveError("The archive contains a file name with a null byte.");

    // Symbolic links are common in real repositories (CLAUDE.md -> AGENTS.md); they are skipped and counted, never
    // followed. Devices, pipes and sockets are still refused.
    let isLink = false;
    if (madeBy >> 8 === UNIX) {
      const type = (externalAttributes >>> 16) & S_IFMT;
      isLink = type === S_IFLNK;
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR && !isLink) {
        throw new ArchiveError("The archive contains a special file (device, pipe or socket), which is not supported.");
      }
    }

    const isDirectory = name.endsWith("/");
    if (isDirectory && (size !== 0 || compressedSize !== 0)) throw malformed();
    if (!isDirectory && method !== 0 && method !== 8) throw new ArchiveError("The archive uses an unsupported compression method.");

    // Local header (files and directories): must exist inside the data area, agree with the central record, and
    // point at its own data.
    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== LOCAL) throw malformed();
    const localFlags = buf.readUInt16LE(localOffset + 6);
    const localMethod = buf.readUInt16LE(localOffset + 8);
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    if (localMethod !== method || (localFlags & 0x0001) !== 0) throw malformed();
    if (localNameLength !== nameLength || !buf.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) {
      throw malformed();
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) throw malformed();
    ranges.push({ start: localOffset, end: dataEnd, descriptor: (flags & 0x0008) !== 0 });
    if (isDirectory) {
      directories++;
      continue;
    }
    if (method === 0 && compressedSize !== size) throw malformed();

    if (isLink) {
      files.push({ name, size, data: null, link: true }); // the link target text is never read
      continue;
    }

    if (size > limits.maxFileBytes) {
      files.push({ name, size, data: null }); // reported as skipped; never decompressed
      continue;
    }
    if (size > 0 && (compressedSize === 0 || size / compressedSize > limits.maxCompressionRatio)) {
      throw new ArchiveError("The archive compresses suspiciously well and was rejected (possible zip bomb).");
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new ArchiveError(`The archive expands to more than ${Math.round(limits.maxTotalBytes / (1024 * 1024))} MB.`);
    }

    const raw = buf.subarray(dataStart, dataEnd);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
    } catch {
      throw new ArchiveError("The archive contains a corrupt or oversized entry.");
    }
    if (data.length !== size || crc32(data) >>> 0 !== crc) throw new ArchiveError("The archive contains a corrupt entry (size or CRC mismatch).");
    files.push({ name, size, data });
  }
  if (p !== eocd) throw malformed();

  // The entries must tile the data area exactly, from byte 0 up to the central directory: no overlapping entries (a
  // known zip-bomb technique), no hidden bytes between them, and nothing prepended (self-extractor stubs, polyglots).
  // The only allowed gap is the data descriptor that follows an entry flagged with bit 3 (12 bytes, or 16 with its
  // optional signature).
  ranges.sort((a, b) => a.start - b.start);
  let expected = 0;
  for (const range of ranges) {
    if (range.start !== expected) throw malformed();
    expected = range.end;
    if (range.descriptor) expected += expected + 4 <= cdOffset && buf.readUInt32LE(expected) === DATA_DESCRIPTOR ? 16 : 12;
  }
  if (expected !== cdOffset) throw malformed();

  return { files, directories, comment };
}
