// Unit tests for archive-based source ingestion: the strict ZIP reader, archive -> manifest, and the snapshot-bound
// source provider. FIXTURE DATA ONLY: every archive here is built in memory by the tiny writer below.
// Run: see docs/repository-ingestion.md ("Tests").
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { countExclusions, matchesManifest, readSourceArchive } from "./archive";
import { ARCHIVE_LIMITS, type ArchiveLimits } from "./limits";
import { createArchiveSourceProvider } from "./provider";
import { ArchiveError, readZip } from "./zip";

// ---------------------------------------------------------------------------------------------- minimal ZIP writer
type Entry = {
  name: string;
  data?: string | Buffer;
  method?: number;
  madeBy?: number;
  mode?: number;
  flags?: number;
  crc?: number;
  size?: number;
  rawName?: Buffer;
};

function zip(entries: Entry[], options: { comment?: string; trailing?: Buffer; prefix?: Buffer; overlapSecond?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = options.prefix?.length ?? 0;
  const offsets: number[] = [];
  for (const [i, e] of entries.entries()) {
    const nameBuf = e.rawName ?? Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data ?? "");
    const method = e.method ?? (e.name.endsWith("/") ? 0 : 8);
    const comp = method === 8 ? deflateRawSync(data) : data;
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const flags = e.flags ?? 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const thisOffset = options.overlapSecond && i === 1 ? offsets[0] : offset;
    offsets.push(thisOffset);
    if (!(options.overlapSecond && i === 1)) {
      locals.push(local, nameBuf, comp);
      offset += 30 + nameBuf.length + comp.length;
    }
    const mode = e.mode ?? (e.name.endsWith("/") ? 0o040755 : 0o100644);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.madeBy ?? (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(thisOffset, 42);
    centrals.push(central, nameBuf);
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? "", "latin1");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([options.prefix ?? Buffer.alloc(0), ...locals, cd, eocd, comment, options.trailing ?? Buffer.alloc(0)]);
}

const L: ArchiveLimits = { ...ARCHIVE_LIMITS };
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const SRC = "export class A {}\n";

function rejects(buf: Buffer, pattern: RegExp, limits: ArchiveLimits = L) {
  assert.throws(() => readSourceArchive(buf, limits), (e: unknown) => e instanceof ArchiveError && pattern.test(e.message));
}

// ------------------------------------------------------------------------------------------------------------ tests
describe("readZip: structure", () => {
  it("reads STORE and DEFLATE entries and verifies CRC and size", () => {
    const z = readZip(zip([{ name: "a.ts", data: SRC, method: 0 }, { name: "b.ts", data: SRC.repeat(20) }, { name: "dir/" }]), L);
    assert.equal(z.files.length, 2);
    assert.equal(z.directories, 1);
    assert.equal(z.files[1].data!.toString(), SRC.repeat(20));
  });

  it("rejects non-ZIP data, trailing data and prepended data", () => {
    rejects(Buffer.from("definitely not a zip file at all"), /not a valid ZIP/);
    rejects(zip([{ name: "a.ts", data: SRC }], { trailing: Buffer.from("junk") }), /not a valid ZIP/);
    rejects(zip([{ name: "a.ts", data: SRC }], { prefix: Buffer.from("MZ-stub") }), /not a valid ZIP/);
  });

  it("rejects a corrupt entry (CRC or size mismatch)", () => {
    rejects(zip([{ name: "a.ts", data: SRC, crc: 12345 }]), /corrupt/);
    rejects(zip([{ name: "a.ts", data: SRC, size: SRC.length + 5 }]), /corrupt/);
  });

  it("rejects encryption, unsupported compression, symlinks and special files", () => {
    rejects(zip([{ name: "a.ts", data: SRC, flags: 0x0801 }]), /Encrypted/);
    rejects(zip([{ name: "a.ts", data: SRC, method: 12 }]), /compression method/);
    rejects(zip([{ name: "link", data: "/etc/passwd", method: 0, mode: 0o120777 }]), /symbolic link/);
    rejects(zip([{ name: "dev", data: "", method: 0, mode: 0o020644 }]), /special file/);
  });

  it("rejects overlapping entries", () => {
    rejects(zip([{ name: "a.ts", data: SRC }, { name: "b.ts", data: SRC }], { overlapSecond: true }), /not a valid ZIP/);
  });

  it("rejects non-UTF-8 names", () => {
    rejects(zip([{ name: "x", rawName: Buffer.from([0x66, 0xff, 0x2e, 0x74, 0x73]), data: SRC, flags: 0x0800 }]), /not valid UTF-8/);
    rejects(zip([{ name: "x", rawName: Buffer.from([0x66, 0xe9, 0x2e, 0x74, 0x73]), data: SRC, flags: 0 }]), /not UTF-8/);
  });

  it("rejects ZIP64 markers", () => {
    const buf = zip([{ name: "a.ts", data: SRC }]);
    const eocd = buf.length - 22;
    buf.writeUInt32LE(0xffffffff, eocd + 16); // central-directory offset = ZIP64 sentinel
    rejects(buf, /ZIP64/);
  });

  it("enforces the entry-count, per-file, total-size, name-length and time limits", () => {
    rejects(zip([{ name: "a.ts", data: SRC }, { name: "b.ts", data: SRC }]), /more than 1 entries/, { ...L, maxEntries: 1 });
    // Oversized single file: skipped, never decompressed.
    const big = readSourceArchive(zip([{ name: "a.ts", data: SRC }, { name: "big.bin", data: "x".repeat(300) }]), { ...L, maxFileBytes: 200 });
    assert.ok(big.skipped.some((s) => s.path === "big.bin" && /larger than/.test(s.reason)));
    assert.ok(!big.contents.has("big.bin"));
    rejects(zip([{ name: "a.ts", data: "y".repeat(150) }, { name: "b.ts", data: "z".repeat(150) }]), /expands to more than/, { ...L, maxTotalBytes: 200, maxCompressionRatio: 1e9 });
    rejects(zip([{ name: `${"d".repeat(40)}.ts`, data: SRC }]), /longer than 20 bytes/, { ...L, maxNameBytes: 20 });
    let t = 0;
    assert.throws(() => readZip(zip([{ name: "a.ts", data: SRC }]), { ...L, maxReadMillis: 5 }, () => (t += 10)), /too long/);
  });

  it("rejects compression bombs by ratio and by a lying size", () => {
    rejects(zip([{ name: "bomb.txt", data: "0".repeat(200_000) }]), /zip bomb/);
    rejects(zip([{ name: "lie.txt", data: "0".repeat(5000), size: 100 }]), /corrupt|zip bomb/, { ...L, maxCompressionRatio: 1e9 });
  });
});

describe("readSourceArchive: paths and manifest", () => {
  it("rejects absolute, drive-letter, traversal, backslash-traversal and null-byte paths", () => {
    rejects(zip([{ name: "/etc/passwd", data: SRC }]), /Absolute/);
    rejects(zip([{ name: "C:/win.ini", data: SRC }]), /Drive-letter/);
    rejects(zip([{ name: "src/../../escape.ts", data: SRC }]), /traversal/);
    rejects(zip([{ name: "src\\..\\..\\escape.ts", data: SRC }]), /traversal/);
    rejects(zip([{ name: "a\u0000.ts", data: SRC }]), /null byte/);
    rejects(zip([{ name: "a\u0085.ts", data: SRC }]), /control characters/); // C1 control: the database CHECK rejects it too
  });

  it("rejects duplicate, Unicode-normalization and case collisions, and file/folder conflicts", () => {
    rejects(zip([{ name: "a.ts", data: SRC }, { name: "a.ts", data: SRC }]), /colliding/);
    rejects(zip([{ name: "caf\u00e9.ts", data: SRC }, { name: "cafe\u0301.ts", data: SRC }]), /colliding/);
    rejects(zip([{ name: "README.md", data: "x" }, { name: "readme.md", data: "y" }]), /colliding/);
    rejects(zip([{ name: "src", data: "x" }, { name: "src/a.ts", data: SRC }]), /both a file and a folder/);
  });

  it("strips one shared top-level folder and skips ignored directories and archive metadata", () => {
    const a = readSourceArchive(
      zip([
        { name: "repo-abc/" },
        { name: "repo-abc/src/a.ts", data: SRC },
        { name: "repo-abc/node_modules/x/index.js", data: "x" },
        { name: "repo-abc/__MACOSX/._a.ts", data: "x" },
        { name: "repo-abc/README.md", data: "# r" },
      ]),
      L,
    );
    assert.deepEqual(a.manifest.map((m) => m.path), ["README.md", "src/a.ts"]);
    assert.deepEqual(a.skipped.map((s) => s.path).sort(), ["__MACOSX/._a.ts", "node_modules/x/index.js"]);
    assert.equal(a.entriesTotal, 4);
  });

  it("records sizes, SHA-256 hashes and languages exactly, deterministically", () => {
    const buf = zip([{ name: "b.py", data: "x = 1\n" }, { name: "a.ts", data: SRC }]);
    const a = readSourceArchive(buf, L);
    const b = readSourceArchive(buf, L);
    assert.deepEqual(a.manifest, b.manifest);
    assert.deepEqual(a.manifest, [
      { path: "a.ts", language: "TypeScript", sizeBytes: Buffer.byteLength(SRC), contentHash: sha(SRC) },
      { path: "b.py", language: "Python", sizeBytes: 6, contentHash: sha("x = 1\n") },
    ]);
    assert.equal(a.archiveSha256, sha(buf));
    assert.equal(a.archiveBytes, buf.length);
    assert.equal(a.contents.get("a.ts")!.toString(), SRC);
  });

  it("refuses an archive with zero recordable files", () => {
    rejects(zip([{ name: "node_modules/x.js", data: "x" }, { name: "empty/" }]), /no files that can be recorded/);
    rejects(zip([{ name: "node_modules/x.js", data: "x" }, { name: ".git/config", data: "y" }]), /no files that can be recorded/);
    rejects(zip([{ name: "only/" }]), /no files that can be recorded/);
  });

  it("enforces the upload-size and file-count limits", () => {
    rejects(zip([{ name: "a.ts", data: SRC }]), /upload limit/, { ...L, maxUploadBytes: 10 });
    rejects(zip([{ name: "a.ts", data: SRC }, { name: "b.ts", data: SRC }]), /more than 1 files/, { ...L, maxFiles: 1 });
    rejects(Buffer.alloc(0), /empty/);
  });

  it("reads the commit the archive claims (ZIP comment) only when it is a full commit id", () => {
    const commit = "a".repeat(40);
    assert.equal(readSourceArchive(zip([{ name: "a.ts", data: SRC }], { comment: commit.toUpperCase() }), L).archiveCommit, commit);
    assert.equal(readSourceArchive(zip([{ name: "a.ts", data: SRC }], { comment: "made by me" }), L).archiveCommit, null);
  });

  it("matchesManifest requires identical paths, sizes and hashes", () => {
    const a = readSourceArchive(zip([{ name: "a.ts", data: SRC }, { name: "b.ts", data: "b" }]), L);
    const recorded = a.manifest.map((m) => ({ path: m.path, sizeBytes: m.sizeBytes, contentHash: m.contentHash }));
    assert.ok(matchesManifest(a, recorded));
    assert.ok(!matchesManifest(a, recorded.slice(1)));
    assert.ok(!matchesManifest(a, [...recorded, { path: "c.ts", sizeBytes: 1, contentHash: sha("c") }]));
    assert.ok(!matchesManifest(a, recorded.map((r, i) => (i === 0 ? { ...r, contentHash: sha("other") } : r))));
  });
});

describe("boundaries and exclusion accounting", () => {
  it("compressed upload size: below and at the limit accepted, above rejected", () => {
    const buf = zip([{ name: "a.ts", data: SRC }]);
    assert.doesNotThrow(() => readSourceArchive(buf, { ...L, maxUploadBytes: buf.length + 1 }));
    assert.doesNotThrow(() => readSourceArchive(buf, { ...L, maxUploadBytes: buf.length }));
    rejects(buf, /upload limit/, { ...L, maxUploadBytes: buf.length - 1 });
  });

  it("total uncompressed size: below and at the limit accepted, above rejected", () => {
    const buf = zip([{ name: "a.ts", data: "a".repeat(100) }, { name: "b.ts", data: "b".repeat(100) }]);
    const limits = { ...L, maxCompressionRatio: 1e9 };
    assert.doesNotThrow(() => readSourceArchive(buf, { ...limits, maxTotalBytes: 201 }));
    assert.doesNotThrow(() => readSourceArchive(buf, { ...limits, maxTotalBytes: 200 }));
    rejects(buf, /expands to more than/, { ...limits, maxTotalBytes: 199 });
  });

  it("per-file size: below and at the limit recorded, above excluded and counted (never decompressed or truncated)", () => {
    const at = "x".repeat(100);
    const over = "y".repeat(101);
    const a = readSourceArchive(zip([{ name: "below.ts", data: "z".repeat(99) }, { name: "at.ts", data: at }, { name: "over.ts", data: over }]), {
      ...L,
      maxFileBytes: 100,
      maxCompressionRatio: 1e9,
    });
    assert.deepEqual(a.manifest.map((m) => m.path), ["at.ts", "below.ts"]);
    assert.equal(a.contents.get("at.ts")!.toString(), at, "recorded bytes are complete, not truncated");
    assert.ok(!a.contents.has("over.ts"));
    assert.deepEqual(a.skipped, [{ path: "over.ts", reason: "larger than the 100 B per-file limit", category: "oversized" }]);
  });

  it("every excluded file has exactly one category and the counts add up", () => {
    const a = readSourceArchive(
      zip([
        { name: "src/a.ts", data: SRC },
        { name: "src/big.bin", data: "q".repeat(300) },
        { name: "node_modules/pkg/huge.js", data: "w".repeat(300) }, // oversized AND generated: counted once, as generated
        { name: "dist/out.js", data: "x" },
        { name: "__MACOSX/._a.ts", data: "m" },
        { name: "README.md", data: "# r" },
      ]),
      { ...L, maxFileBytes: 200, maxCompressionRatio: 1e9 },
    );
    const counts = countExclusions(a.skipped);
    assert.deepEqual(counts, { oversized: 1, generated: 2, metadata: 1, sensitive: 0 });
    assert.equal(counts.oversized + counts.generated + counts.metadata + counts.sensitive, a.skipped.length);
    assert.equal(a.manifest.length + a.skipped.length, a.entriesTotal);
    assert.deepEqual(a.manifest.map((m) => m.path), ["README.md", "src/a.ts"]);
  });

  it("files that may hold credentials are never recorded, hashed or kept, and are counted as sensitive", () => {
    const a = readSourceArchive(
      zip([
        { name: "src/a.ts", data: SRC },
        { name: ".env", data: "DB_PASSWORD=secret" },
        { name: "config/.env.production", data: "TOKEN=x" },
        { name: ".env.example", data: "DB_PASSWORD=" }, // a template: recorded
        { name: "certs/server.pem", data: "-----BEGIN PRIVATE KEY-----" },
        { name: "deploy/id_ed25519", data: "key" },
        { name: ".npmrc", data: "//registry/:_authToken=x" },
        { name: "src/keyboard.ts", data: SRC }, // look-alike name: recorded
        { name: "node_modules/pkg/.env", data: "x" }, // inside a generated folder: counted as generated
      ]),
      L,
    );
    const counts = countExclusions(a.skipped);
    assert.deepEqual(counts, { oversized: 0, generated: 1, metadata: 0, sensitive: 5 });
    assert.deepEqual(a.manifest.map((m) => m.path), [".env.example", "src/a.ts", "src/keyboard.ts"]);
    for (const secret of [".env", "config/.env.production", "certs/server.pem", "deploy/id_ed25519", ".npmrc"]) {
      assert.equal(a.contents.has(secret), false, `${secret} bytes are not kept`);
    }
    assert.equal(a.manifest.length + a.skipped.length, a.entriesTotal);
  });

  it("an empty archive (no entries) is rejected", () => {
    rejects(zip([]), /no files that can be recorded/);
  });

  it("files directly at the root keep their paths", () => {
    const a = readSourceArchive(zip([{ name: "a.ts", data: SRC }, { name: "src/b.ts", data: SRC }]), L);
    assert.deepEqual(a.manifest.map((m) => m.path), ["a.ts", "src/b.ts"]);
  });

  it("a GitHub-style archive (one top-level folder, folder entries, commit in the comment) is the repository root", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const a = readSourceArchive(
      zip(
        [
          { name: `acme-repo-${commit.slice(0, 7)}/` },
          { name: `acme-repo-${commit.slice(0, 7)}/src/` },
          { name: `acme-repo-${commit.slice(0, 7)}/src/index.ts`, data: SRC },
          { name: `acme-repo-${commit.slice(0, 7)}/package.json`, data: "{}" },
        ],
        { comment: commit },
      ),
      L,
    );
    assert.deepEqual(a.manifest.map((m) => m.path), ["package.json", "src/index.ts"]);
    assert.equal(a.archiveCommit, commit);
  });
});

describe("createArchiveSourceProvider", () => {
  const archive = readSourceArchive(zip([{ name: "a.ts", data: SRC }, { name: "b.ts", data: "export const b = 1;\n" }]), L);
  const manifest = archive.manifest.map((m, i) => ({ id: `file-${i}`, path: m.path, language: m.language, sizeBytes: m.sizeBytes, contentHash: m.contentHash }));
  const provider = createArchiveSourceProvider(manifest, archive.contents);

  it("returns the exact bytes of a recorded file", async () => {
    assert.equal(provider.available, true);
    assert.equal(await provider.getContent(manifest[0]), SRC);
  });

  it("answers only for its own snapshot's manifest rows", async () => {
    assert.equal(await provider.getContent({ ...manifest[0], id: "file-of-another-snapshot" }), null);
    assert.equal(await provider.getContent({ ...manifest[0], path: "b.ts" }), null);
  });

  it("rejects a manifest/content hash or size mismatch", async () => {
    const tampered = new Map(archive.contents);
    tampered.set("a.ts", Buffer.from("export class Evil {}\n"));
    const p = createArchiveSourceProvider(manifest, tampered);
    assert.equal(await p.getContent(manifest[0]), null);
    assert.equal(await provider.getContent({ ...manifest[0], contentHash: sha("x") }), null);
    assert.equal(await provider.getContent({ ...manifest[0], sizeBytes: 1 }), null);
  });
});
