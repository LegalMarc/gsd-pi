// Recovery-evidence resolution without the native projection lock, and
// interrupted-resolution retry (#2815). File Purpose: verifies that once the
// ProjectionRootIdentityLock health latch degrades the store to plain fs
// (#2489), file-scoped retained evidence stays fully resolvable through
// resolveUnboundProjectionEvidence (discard/preserve/restore) with the native
// path's byte-verification guarantees; that a resolving record from a crashed
// attempt stays enumerable and safely resolvable instead of poisoning the
// index; and that a prepared native-mode resolution whose guard/exchange
// artifacts were removed converges on replay instead of wedging every managed
// open. The degraded cases run in native-enabled CI by tripping the real latch
// in process (and under GSD_NATIVE_DISABLE=1 they degrade naturally).

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  _latchProjectionRootIdentityLockForTest,
  _resetProjectionRootIdentityLockHealthForTest,
  isProjectionRootIdentityLockAvailable,
} from "@gsd/native/file-identity";

import {
  _setUnboundEvidenceCopyFaultForTest,
  _setUnboundEvidenceExchangeFaultForTest,
  loadUnboundProjectionEvidence,
  previewUnboundProjectionEvidenceResolution,
  resolveUnboundProjectionEvidence,
  type UnboundProjectionEvidenceResolutionAction,
} from "../managed-projection-history.ts";

const nativeMode = isProjectionRootIdentityLockAvailable();

// With the addon present, trip the real health latch so every
// isProjectionRootIdentityLockAvailable() gate degrades exactly as it does
// after 3 consecutive transient failures; without it the store is already
// degraded. Reset afterwards so the latch never leaks between tests.
function degradeForTest(t: import("node:test").TestContext): void {
  if (isProjectionRootIdentityLockAvailable()) _latchProjectionRootIdentityLockForTest();
  t.after(() => _resetProjectionRootIdentityLockHealthForTest());
}

const REVIEWED = "reviewed evidence bytes\n";

interface EvidenceFixture {
  base: string;
  rootPath: string;
  logicalPath: string;
  evidencePath: string;
  evidenceId: string;
  contentDigest: string;
  indexPath: string;
}

// Seeds a retained file-scope evidence record the way the persisted index
// stores it, mirroring the engine's evidenceId/digest derivations.
function seedEvidenceFixture(prefix: string): EvidenceFixture {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const rootPath = join(base, ".gsd");
  const logicalPath = "notes/result.md";
  const evidencePath = `notes/.gsd-projection-remove-${randomUUID()}`;
  const indexPath = join(rootPath, "migration", "unbound-projection-evidence.json");
  mkdirSync(dirname(join(rootPath, evidencePath)), { recursive: true });
  writeFileSync(join(rootPath, evidencePath), REVIEWED);
  const stat = lstatSync(join(rootPath, evidencePath), { bigint: true });
  const evidenceId = `evidence:sha256:${createHash("sha256")
    .update(JSON.stringify({ evidencePath, kind: "quarantine", logicalPath, scope: "file" }))
    .digest("hex")}`;
  const contentDigest = `sha256:${createHash("sha256").update(REVIEWED).digest("hex")}`;
  mkdirSync(join(rootPath, "migration"), { recursive: true });
  writeFileSync(indexPath, `${JSON.stringify([{
    evidenceId,
    evidencePath,
    evidenceIdentity: `${stat.dev}:${stat.ino}`,
    contentDigest,
    kind: "quarantine",
    logicalPath,
    scope: "file",
    transition: "retained",
  }])}\n`);
  return { base, rootPath, logicalPath, evidencePath, evidenceId, contentDigest, indexPath };
}

function cleanupFixture(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function readIndex(base: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(
    join(base, ".gsd", "migration", "unbound-projection-evidence.json"),
    "utf8",
  )) as Array<Record<string, unknown>>;
}

test("degraded file-scope discard verifies the reviewed bytes before removal", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-plainfs-discard-");
  t.after(() => cleanupFixture(fixture.base));

  const preview = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "discard",
  );
  assert.equal(preview.destinationPath, null);

  // Bytes diverging from the reviewed content must refuse and survive.
  writeFileSync(join(fixture.rootPath, fixture.evidencePath), "tampered\n");
  assert.throws(
    () => resolveUnboundProjectionEvidence(
      fixture.base,
      fixture.evidenceId,
      "discard",
      preview.consent,
    ),
    /consent does not match the reviewed content/u,
  );
  assert.equal(readFileSync(join(fixture.rootPath, fixture.evidencePath), "utf8"), "tampered\n");
  assert.equal(loadUnboundProjectionEvidence(fixture.base).length, 1);

  // The exact reviewed bytes consent to the discard.
  writeFileSync(join(fixture.rootPath, fixture.evidencePath), REVIEWED);
  resolveUnboundProjectionEvidence(fixture.base, fixture.evidenceId, "discard", preview.consent);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
});

test("degraded restore republishes the reviewed bytes and resolves", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-plainfs-restore-");
  t.after(() => cleanupFixture(fixture.base));

  const destination = join(fixture.rootPath, fixture.logicalPath);
  // An occupied destination with different content refuses, unchanged.
  mkdirSync(join(fixture.rootPath, "notes"), { recursive: true });
  writeFileSync(destination, "current render\n");
  const blocked = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "restore",
  );
  assert.throws(
    () => resolveUnboundProjectionEvidence(
      fixture.base,
      fixture.evidenceId,
      "restore",
      blocked.consent,
    ),
    /destination already contains different content/u,
  );
  assert.equal(readFileSync(destination, "utf8"), "current render\n");
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), true);

  // With the target free, restore lands the reviewed bytes and retires the record.
  unlinkSync(destination);
  const preview = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "restore",
  );
  assert.equal(preview.destinationPath, fixture.logicalPath);
  resolveUnboundProjectionEvidence(fixture.base, fixture.evidenceId, "restore", preview.consent);
  assert.equal(readFileSync(destination, "utf8"), REVIEWED);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
});

test("degraded preserve retains the reviewed bytes under migration and resolves", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-plainfs-preserve-");
  t.after(() => cleanupFixture(fixture.base));

  const preview = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "preserve",
  );
  assert.match(preview.destinationPath ?? "", /^migration\/preserved-projection-evidence\//u);
  resolveUnboundProjectionEvidence(fixture.base, fixture.evidenceId, "preserve", preview.consent);
  assert.equal(
    readFileSync(join(fixture.rootPath, preview.destinationPath!), "utf8"),
    REVIEWED,
  );
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
});

test("degraded canonical restore retires the record in place after verification", (t) => {
  degradeForTest(t);
  const base = mkdtempSync(join(tmpdir(), "gsd-evidence-plainfs-canonical-"));
  t.after(() => cleanupFixture(base));
  const rootPath = join(base, ".gsd");
  mkdirSync(join(rootPath, "migration"), { recursive: true });
  writeFileSync(join(rootPath, "state.md"), REVIEWED);
  const stat = lstatSync(join(rootPath, "state.md"), { bigint: true });
  const evidenceId = `evidence:sha256:${createHash("sha256")
    .update(JSON.stringify({ evidencePath: "state.md", kind: "canonical", logicalPath: "state.md", scope: "file" }))
    .digest("hex")}`;
  writeFileSync(join(rootPath, "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
    evidenceId,
    evidencePath: "state.md",
    evidenceIdentity: `${stat.dev}:${stat.ino}`,
    contentDigest: `sha256:${createHash("sha256").update(REVIEWED).digest("hex")}`,
    kind: "canonical",
    logicalPath: "state.md",
    scope: "file",
    transition: "retained",
  }])}\n`);

  const preview = previewUnboundProjectionEvidenceResolution(base, evidenceId, "restore");
  assert.equal(preview.destinationPath, "state.md");
  resolveUnboundProjectionEvidence(base, evidenceId, "restore", preview.consent);
  // The reviewed bytes stay in place; only the protecting record retires.
  assert.equal(readFileSync(join(rootPath, "state.md"), "utf8"), REVIEWED);
  assert.deepEqual(loadUnboundProjectionEvidence(base), []);
});

test("a canonical restore replay keeps the restored bytes in place", (t) => {
  degradeForTest(t);
  const base = mkdtempSync(join(tmpdir(), "gsd-evidence-plainfs-canonical-replay-"));
  t.after(() => cleanupFixture(base));
  const rootPath = join(base, ".gsd");
  mkdirSync(join(rootPath, "migration"), { recursive: true });
  writeFileSync(join(rootPath, "state.md"), REVIEWED);
  const stat = lstatSync(join(rootPath, "state.md"), { bigint: true });
  const digest = `sha256:${createHash("sha256").update(REVIEWED).digest("hex")}`;
  const evidenceId = `evidence:sha256:${createHash("sha256")
    .update(JSON.stringify({ evidencePath: "state.md", kind: "canonical", logicalPath: "state.md", scope: "file" }))
    .digest("hex")}`;
  // A crash after the deleting marker of a canonical restore: destination and
  // evidence path are the same file. The replay must retire the record
  // without unlinking the restored bytes it just verified.
  writeFileSync(join(rootPath, "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
    evidenceId,
    evidencePath: "state.md",
    evidenceIdentity: `${stat.dev}:${stat.ino}`,
    contentDigest: digest,
    kind: "canonical",
    logicalPath: "state.md",
    scope: "file",
    transition: "resolving",
    resolution: {
      action: "restore",
      currentIdentity: `${stat.dev}:${stat.ino}`,
      contentDigest: digest,
      destinationPath: "state.md",
      guardPath: ".gsd-projection-remove-11111111-2222-4333-8444-555555555555",
      guardIdentity: null,
      stagingPath: null,
      stagingIdentity: null,
      exchangePath: ".gsd-projection-exchange-11111111-2222-4333-8444-555555555555",
      exchangeIdentity: null,
      phase: "deleting",
    },
  }])}\n`);

  resolveUnboundProjectionEvidence(
    base,
    evidenceId,
    "restore",
    "consent is not re-asked for a replayed deletion",
  );
  assert.equal(readFileSync(join(rootPath, "state.md"), "utf8"), REVIEWED);
  assert.deepEqual(loadUnboundProjectionEvidence(base), []);
});

test("degraded replay keeps an unknown exchange-slot occupant under the projection root", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-plainfs-gate-root-");
  t.after(() => cleanupFixture(fixture.base));

  // The journaled exchange slot holds bytes no protocol placeholder ever has
  // (placeholders are empty): they are not ours to delete. The replay must
  // find them under the projection root (not the process cwd), keep them as
  // their own reviewable record, and still finish the persisted discard of
  // the reviewed bytes it located at the evidence path (#2819).
  const exchangePath = `notes/.gsd-projection-exchange-${randomUUID()}`;
  writeFileSync(join(fixture.rootPath, exchangePath), "exchange placeholder\n");
  const pivotStat = lstatSync(join(fixture.rootPath, exchangePath), { bigint: true });
  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath,
    exchangeIdentity: `${pivotStat.dev}:${pivotStat.ino}`,
    phase: "prepared",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);

  // The persisted resolution is the consent; it is not re-asked.
  resolveUnboundProjectionEvidence(
    fixture.base,
    fixture.evidenceId,
    "discard",
    "discard:sha256:0",
  );
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.equal(readFileSync(join(fixture.rootPath, exchangePath), "utf8"), "exchange placeholder\n");
  const listed = loadUnboundProjectionEvidence(fixture.base);
  assert.deepEqual(listed.map((entry) => [entry.evidencePath, entry.kind, entry.transition]), [
    [exchangePath, "quarantine", "retained"],
  ]);
});

test("a mid-rotation missing guard placeholder is not re-prepared", { skip: !nativeMode }, (t) => {
  const fixture = seedEvidenceFixture("gsd-evidence-latch-midrotation-");
  t.after(() => cleanupFixture(fixture.base));

  // Windows rotation state: the guard placeholder was renamed into the pivot,
  // so the guard path is missing while the pivot holds its identity, and the
  // reviewed content is still at the evidence path. The engine resumes that
  // exchange itself; the heal must not re-prepare over it.
  const token = (label: string): string => {
    const hex = createHash("sha256").update(`${label}\0${fixture.evidenceId}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };
  const guardPath = `notes/.gsd-projection-remove-${token("guard")}`;
  const exchangePath = `notes/.gsd-projection-exchange-${token("exchange")}`;
  writeFileSync(join(fixture.rootPath, exchangePath), "guard placeholder bytes\n");
  const pivotStat = lstatSync(join(fixture.rootPath, exchangePath), { bigint: true });
  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath,
    guardIdentity: `${pivotStat.dev}:${pivotStat.ino}`,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath,
    exchangeIdentity: "1:1",
    phase: "prepared",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);

  // The engine cannot resume this triple on Unix (the rotation branch is
  // Windows-only), so the replay fails — but the heal must leave the
  // journaled identities untouched for the state the engine can resume.
  assert.throws(
    () => loadUnboundProjectionEvidence(fixture.base),
    /identity changed/u,
  );
  const replayed = readIndex(fixture.base) as Array<Record<string, unknown>>;
  assert.equal(replayed[0]!.transition, "resolving");
  assert.equal(
    (replayed[0]!.resolution as Record<string, unknown>).guardIdentity,
    `${pivotStat.dev}:${pivotStat.ino}`,
  );
  assert.equal(readFileSync(join(fixture.rootPath, fixture.evidencePath), "utf8"), REVIEWED);
});

test("an externally cleaned guard with an intact pivot replays to completion", { skip: !nativeMode }, (t) => {
  const fixture = seedEvidenceFixture("gsd-evidence-latch-cleaned-guard-");
  t.after(() => cleanupFixture(fixture.base));

  // External cleanup removed only the guard placeholder; the exchange pivot
  // still holds its own placeholder. That state is not a rotation state the
  // engine resumes (the pivot holds the exchange identity, not the guard's),
  // so the heal resets the guard identity and the exchange replays to
  // completion with a fresh guard placeholder.
  const token = (label: string): string => {
    const hex = createHash("sha256").update(`${label}\0${fixture.evidenceId}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };
  const guardPath = `notes/.gsd-projection-remove-${token("guard")}`;
  const exchangePath = `notes/.gsd-projection-exchange-${token("exchange")}`;
  writeFileSync(join(fixture.rootPath, exchangePath), "exchange placeholder bytes\n");
  const pivotStat = lstatSync(join(fixture.rootPath, exchangePath), { bigint: true });
  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath,
    guardIdentity: "9:9",
    stagingPath: null,
    stagingIdentity: null,
    exchangePath,
    exchangeIdentity: `${pivotStat.dev}:${pivotStat.ino}`,
    phase: "prepared",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);

  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.equal(existsSync(join(fixture.rootPath, exchangePath)), false);
  assert.deepEqual(readIndex(fixture.base), []);
});

test("a partially persisted heal re-resets the exchange identity on replay", { skip: !nativeMode }, (t) => {
  const fixture = seedEvidenceFixture("gsd-evidence-latch-partial-heal-");
  t.after(() => cleanupFixture(fixture.base));

  // Crash between the two heal reset persists: the guard identity was
  // already reset (null) while the exchange identity is still journaled.
  // There is no journaled exchange left to resume, so the replay must reset
  // the exchange identity too and converge in one pass.
  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: "1:1",
    phase: "prepared",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);

  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(readIndex(fixture.base), []);
});

test("native replay completes a plain-fs deleting marker and removes the reviewed source", { skip: !nativeMode }, (t) => {
  const fixture = seedEvidenceFixture("gsd-evidence-latch-marker-");
  t.after(() => cleanupFixture(fixture.base));

  // Crash window of a degraded discard: the deleting marker is persisted, the
  // unlink never ran. The next native recovery must remove the reviewed bytes
  // under the lock (not just retire the record and leak the file).
  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: null,
    phase: "deleting",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);

  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(readIndex(fixture.base), []);
});

test("a resolving record from a crashed attempt is finished by the degraded replay", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-plainfs-resolving-");
  t.after(() => cleanupFixture(fixture.base));

  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: null,
    phase: "prepared",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);

  // Pre-#2815 the whole index read refused the record. Like the native open,
  // the degraded read now replays it: the reviewed bytes are still at the
  // evidence path, so the persisted discard completes (#2819).
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(readIndex(fixture.base), []);
});

test("degraded replay retains an unknown guard-slot occupant instead of deleting it", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-plainfs-inflight-");
  t.after(() => cleanupFixture(fixture.base));

  const entries = readIndex(fixture.base) as Array<Record<string, unknown>>;
  const guardPath = `notes/.gsd-projection-remove-${randomUUID()}`;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath,
    guardIdentity: entries[0]!.evidenceIdentity,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: null,
    phase: "prepared",
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);
  // The prepared guard slot holds bytes that are neither the reviewed content
  // nor a journaled empty placeholder. The replay locates the reviewed bytes
  // by digest (here still at the evidence path), never treats the guard
  // occupant as protocol-owned, and keeps it as its own record for review.
  writeFileSync(join(fixture.rootPath, guardPath), "prepared placeholder\n");

  resolveUnboundProjectionEvidence(
    fixture.base,
    fixture.evidenceId,
    "discard",
    "discard:sha256:0".repeat(8),
  );
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.equal(readFileSync(join(fixture.rootPath, guardPath), "utf8"), "prepared placeholder\n");
  assert.deepEqual(
    loadUnboundProjectionEvidence(fixture.base).map((entry) => [entry.evidencePath, entry.kind]),
    [[guardPath, "quarantine"]],
  );
});

test("degraded resolution completes a persisted deleting marker idempotently", (t) => {
  degradeForTest(t);
  // Discard marker: the removal phase was persisted, the crash hit before the
  // unlink. The replay finishes both halves without fresh consent.
  const discard = seedEvidenceFixture("gsd-evidence-plainfs-marker-");
  t.after(() => cleanupFixture(discard.base));
  const entries = readIndex(discard.base) as Array<Record<string, unknown>>;
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action: "discard",
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: null,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: null,
    phase: "deleting",
  };
  writeFileSync(discard.indexPath, `${JSON.stringify(entries)}\n`);
  resolveUnboundProjectionEvidence(
    discard.base,
    discard.evidenceId,
    "discard",
    "consent is not re-asked for a replayed deletion",
  );
  assert.equal(existsSync(join(discard.rootPath, discard.evidencePath)), false);
  assert.deepEqual(loadUnboundProjectionEvidence(discard.base), []);

  // Preserve marker with a verified destination: the source goes, the
  // preserved copy stays. A changed destination refuses the completion.
  const preserve = seedEvidenceFixture("gsd-evidence-plainfs-marker-2-");
  t.after(() => cleanupFixture(preserve.base));
  // The preserved path the protocol derives (the native reader rejects any other).
  const preservedRelative = preservedPath(preserve);
  mkdirSync(dirname(join(preserve.rootPath, preservedRelative)), { recursive: true });
  writeFileSync(join(preserve.rootPath, preservedRelative), REVIEWED);
  const preserveEntries = readIndex(preserve.base) as Array<Record<string, unknown>>;
  preserveEntries[0]!.transition = "resolving";
  preserveEntries[0]!.resolution = {
    action: "preserve",
    currentIdentity: preserveEntries[0]!.evidenceIdentity,
    contentDigest: preserveEntries[0]!.contentDigest,
    destinationPath: preservedRelative,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: null,
    phase: "deleting",
  };
  writeFileSync(preserve.indexPath, `${JSON.stringify(preserveEntries)}\n`);
  resolveUnboundProjectionEvidence(
    preserve.base,
    preserve.evidenceId,
    "preserve",
    "consent is not re-asked for a replayed deletion",
  );
  assert.equal(existsSync(join(preserve.rootPath, preserve.evidencePath)), false);
  assert.equal(readFileSync(join(preserve.rootPath, preservedRelative), "utf8"), REVIEWED);
  assert.deepEqual(loadUnboundProjectionEvidence(preserve.base), []);

  // A destination that no longer holds the reviewed bytes must stop the
  // replay without wedging it: nothing is overwritten or removed, and the
  // record returns to review (a fresh consent is needed) instead of failing
  // the same way on every later attempt (#2819).
  const changed = seedEvidenceFixture("gsd-evidence-plainfs-marker-3-");
  t.after(() => cleanupFixture(changed.base));
  const changedPreserved = preservedPath(changed);
  mkdirSync(dirname(join(changed.rootPath, changedPreserved)), { recursive: true });
  writeFileSync(join(changed.rootPath, changedPreserved), "rewritten elsewhere\n");
  const changedEntries = readIndex(changed.base) as Array<Record<string, unknown>>;
  changedEntries[0]!.transition = "resolving";
  changedEntries[0]!.resolution = {
    action: "preserve",
    currentIdentity: changedEntries[0]!.evidenceIdentity,
    contentDigest: changedEntries[0]!.contentDigest,
    destinationPath: changedPreserved,
    guardPath: `notes/.gsd-projection-remove-${randomUUID()}`,
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: `notes/.gsd-projection-exchange-${randomUUID()}`,
    exchangeIdentity: null,
    phase: "deleting",
  };
  writeFileSync(changed.indexPath, `${JSON.stringify(changedEntries)}\n`);
  assert.throws(
    () => resolveUnboundProjectionEvidence(
      changed.base,
      changed.evidenceId,
      "preserve",
      "consent is not re-asked for a replayed deletion",
    ),
    /consent does not match the reviewed content/u,
  );
  assert.equal(readFileSync(join(changed.rootPath, changed.evidencePath), "utf8"), REVIEWED);
  assert.equal(readFileSync(join(changed.rootPath, changedPreserved), "utf8"), "rewritten elsewhere\n");
  assert.deepEqual(
    loadUnboundProjectionEvidence(changed.base).map((entry) => [entry.evidenceId, entry.transition]),
    [[changed.evidenceId, "retained"]],
  );
});

test("degraded tree-scope restrictions are unchanged (empty-tree discard only)", (t) => {
  degradeForTest(t);
  const base = mkdtempSync(join(tmpdir(), "gsd-evidence-plainfs-tree-"));
  t.after(() => cleanupFixture(base));
  const rootPath = join(base, ".gsd");
  const logicalPath = "notes/result.md";
  const indexPath = join(rootPath, "migration", "unbound-projection-evidence.json");

  const seedTreeEvidence = (evidencePath: string, occupied: boolean): string => {
    mkdirSync(join(rootPath, evidencePath), { recursive: true });
    if (occupied) writeFileSync(join(rootPath, evidencePath, "child.md"), "kept\n");
    const stat = lstatSync(join(rootPath, evidencePath), { bigint: true });
    const evidenceId = `evidence:sha256:${createHash("sha256")
      .update(JSON.stringify({ evidencePath, kind: "quarantine", logicalPath, scope: "tree" }))
      .digest("hex")}`;
    mkdirSync(join(rootPath, "migration"), { recursive: true });
    writeFileSync(indexPath, `${JSON.stringify([{
      evidenceId,
      evidencePath,
      evidenceIdentity: `${stat.dev}:${stat.ino}`,
      contentDigest: `sha256:${createHash("sha256").update(occupied ? "kept\n" : "").digest("hex")}`,
      kind: "quarantine",
      logicalPath,
      scope: "tree",
      transition: "retained",
    }])}\n`);
    return evidenceId;
  };

  // Non-empty tree discard and tree preserve/restore keep requiring the lock.
  const occupiedId = seedTreeEvidence(`notes/.gsd-projection-remove-${randomUUID()}`, true);
  const occupiedPreview = previewUnboundProjectionEvidenceResolution(base, occupiedId, "discard");
  assert.throws(
    () => resolveUnboundProjectionEvidence(base, occupiedId, "discard", occupiedPreview.consent),
    /required to discard non-empty evidence/u,
  );
  const occupiedPreserve = previewUnboundProjectionEvidenceResolution(base, occupiedId, "preserve");
  assert.throws(
    () => resolveUnboundProjectionEvidence(base, occupiedId, "preserve", occupiedPreserve.consent),
    /required to preserve or restore evidence/u,
  );
  assert.equal(loadUnboundProjectionEvidence(base).length, 1);

  // The historical allowance holds: an empty tree discards without the lock.
  const emptyId = seedTreeEvidence(`notes/.gsd-projection-remove-${randomUUID()}`, false);
  const emptyPreview = previewUnboundProjectionEvidenceResolution(base, emptyId, "discard");
  resolveUnboundProjectionEvidence(base, emptyId, "discard", emptyPreview.consent);
  // Only the occupied evidence directory remains on disk, and the index is clear.
  assert.equal(readdirSync(join(rootPath, "notes")).length, 1);
  assert.deepEqual(loadUnboundProjectionEvidence(base), []);
});

test("an interrupted native resolution whose artifacts vanished converges on replay", { skip: !nativeMode }, (t) => {
  const fixture = seedEvidenceFixture("gsd-evidence-latch-retry-");
  t.after(() => cleanupFixture(fixture.base));
  t.after(() => _setUnboundEvidenceExchangeFaultForTest(null));

  // Drive a real resolution and interrupt it the way the report describes:
  // the guard/exchange placeholders are prepared and persisted, then removed
  // by a one-time external cleanup before the exchange runs.
  const preview = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "discard",
  );
  let cleaned = false;
  _setUnboundEvidenceExchangeFaultForTest((exchange) => {
    if (!cleaned) {
      cleaned = true;
      const seeded = readIndex(fixture.base) as Array<Record<string, unknown>>;
      const resolution = seeded[0]!.resolution as { guardPath: string; exchangePath: string };
      unlinkSync(join(fixture.rootPath, resolution.guardPath));
      unlinkSync(join(fixture.rootPath, resolution.exchangePath));
    }
    exchange();
  });
  assert.throws(
    () => resolveUnboundProjectionEvidence(
      fixture.base,
      fixture.evidenceId,
      "discard",
      preview.consent,
    ),
    /identity changed/u,
  );
  // The attempt left the record resolving at "prepared" with identities
  // pointing at artifacts that no longer exist (read without a managed open,
  // which is exactly what used to replay the doomed exchange).
  const stuck = readIndex(fixture.base) as Array<Record<string, unknown>>;
  assert.equal(stuck[0]!.transition, "resolving");
  assert.equal((stuck[0]!.resolution as Record<string, unknown>).phase, "prepared");
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), true);

  // The next managed open must converge instead of replaying a doomed
  // exchange forever: the record resolves and the reviewed bytes go.
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.deepEqual(readIndex(fixture.base), []);
});

test("a completed exchange replays idempotently instead of being re-prepared", { skip: !nativeMode }, (t) => {
  const fixture = seedEvidenceFixture("gsd-evidence-latch-exchanged-");
  t.after(() => cleanupFixture(fixture.base));
  t.after(() => _setUnboundEvidenceExchangeFaultForTest(null));

  // Crash in the window after the exchange consumed its pivot but before the
  // JS persisted the new phase: the content already sits at the guard path and
  // the exchange path is gone. The replay must recognize the completed state
  // and finish, not re-prepare over it (#2815 codex finding).
  const preview = previewUnboundProjectionEvidenceResolution(
    fixture.base,
    fixture.evidenceId,
    "discard",
  );
  let crashed = false;
  _setUnboundEvidenceExchangeFaultForTest((exchange) => {
    exchange();
    if (!crashed) {
      crashed = true;
      throw new Error("crashed after the exchange consumed its pivot");
    }
  });
  assert.throws(
    () => resolveUnboundProjectionEvidence(
      fixture.base,
      fixture.evidenceId,
      "discard",
      preview.consent,
    ),
    /crashed after the exchange/u,
  );
  const exchanged = readIndex(fixture.base) as Array<Record<string, unknown>>;
  assert.equal(exchanged[0]!.transition, "resolving");

  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
});

for (const action of ["discard", "preserve", "restore"] as const satisfies readonly UnboundProjectionEvidenceResolutionAction[]) {
  test(`native ${action} resolution is unchanged`, { skip: !nativeMode }, (t) => {
    const fixture = seedEvidenceFixture(`gsd-evidence-native-${action}-`);
    t.after(() => cleanupFixture(fixture.base));

    const preview = previewUnboundProjectionEvidenceResolution(
      fixture.base,
      fixture.evidenceId,
      action,
    );
    resolveUnboundProjectionEvidence(fixture.base, fixture.evidenceId, action, preview.consent);
    if (action === "discard") {
      assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
    } else {
      const landed = action === "restore"
        ? join(fixture.rootPath, fixture.logicalPath)
        : join(fixture.rootPath, preview.destinationPath!);
      assert.equal(readFileSync(landed, "utf8"), REVIEWED);
      assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
    }
    assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  });
}

// ---------------------------------------------------------------------------
// #2819: a resolution the native lane started and could not finish (the
// Windows os error 32 family after the latch cool-off) must be finishable by
// the degraded lane, wherever the attempt left the reviewed bytes.
// ---------------------------------------------------------------------------

const WINDOWS_SHARING_VIOLATION =
  "projection root operation failed: transient projection root sharing violation while renaming projection child (os error 32)";

function identityOf(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

function defaultResolutionPath(fixture: EvidenceFixture, slot: "guard" | "exchange"): string {
  const hex = createHash("sha256").update(`${slot}\0${fixture.evidenceId}`).digest("hex");
  const token = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return `notes/.gsd-projection-${slot === "guard" ? "remove" : "exchange"}-${token}`;
}

function preservedPath(fixture: EvidenceFixture): string {
  return `migration/preserved-projection-evidence/${fixture.evidenceId.slice("evidence:sha256:".length)}`;
}

function destinationFor(fixture: EvidenceFixture, action: UnboundProjectionEvidenceResolutionAction): string | null {
  if (action === "discard") return null;
  return action === "restore" ? fixture.logicalPath : preservedPath(fixture);
}

// Rewrites the seeded row as an in-flight resolution, keeping the identity and
// digest the row was reviewed with.
function seedResolving(
  fixture: EvidenceFixture,
  action: UnboundProjectionEvidenceResolutionAction,
  resolution: Record<string, unknown>,
): void {
  const entries = readIndex(fixture.base);
  entries[0]!.transition = "resolving";
  entries[0]!.resolution = {
    action,
    currentIdentity: entries[0]!.evidenceIdentity,
    contentDigest: entries[0]!.contentDigest,
    destinationPath: destinationFor(fixture, action),
    guardPath: defaultResolutionPath(fixture, "guard"),
    guardIdentity: null,
    stagingPath: null,
    stagingIdentity: null,
    exchangePath: defaultResolutionPath(fixture, "exchange"),
    exchangeIdentity: null,
    phase: "prepared",
    ...resolution,
  };
  writeFileSync(fixture.indexPath, `${JSON.stringify(entries)}\n`);
}

function protocolArtifacts(fixture: EvidenceFixture): string[] {
  return readdirSync(join(fixture.rootPath, "notes"))
    .filter((name) => name.startsWith(".gsd-projection-"))
    .map((name) => `notes/${name}`)
    .sort();
}

for (const action of ["discard", "preserve", "restore"] as const satisfies readonly UnboundProjectionEvidenceResolutionAction[]) {
  test(`a native ${action} that failed with a sharing violation is finished by the degraded lane (#2819)`, { skip: !nativeMode }, (t) => {
    const fixture = seedEvidenceFixture(`gsd-evidence-2819-native-${action}-`);
    t.after(() => cleanupFixture(fixture.base));
    t.after(() => {
      _setUnboundEvidenceExchangeFaultForTest(null);
      _setUnboundEvidenceCopyFaultForTest(null);
    });

    // The first attempt after the latch cool-off runs natively: the exchange
    // hits the Windows sharing violation, the copy fallback hits it again, and
    // the attempt dies with the record mid-protocol and its private guard and
    // exchange artifacts on disk.
    const preview = previewUnboundProjectionEvidenceResolution(fixture.base, fixture.evidenceId, action);
    _setUnboundEvidenceExchangeFaultForTest(() => { throw new Error(WINDOWS_SHARING_VIOLATION); });
    _setUnboundEvidenceCopyFaultForTest(() => { throw new Error(WINDOWS_SHARING_VIOLATION); });
    assert.throws(
      () => resolveUnboundProjectionEvidence(fixture.base, fixture.evidenceId, action, preview.consent),
      /sharing violation/u,
    );
    _setUnboundEvidenceExchangeFaultForTest(null);
    _setUnboundEvidenceCopyFaultForTest(null);
    const stuck = readIndex(fixture.base);
    assert.equal(stuck[0]!.transition, "resolving");
    assert.equal((stuck[0]!.resolution as Record<string, unknown>).phase, "prepared");
    assert.ok(protocolArtifacts(fixture).length > 1, "the failed attempt left its private artifacts");

    // Every later attempt runs degraded. Re-issuing the same command finishes
    // the resolution the operator already consented to.
    degradeForTest(t);
    resolveUnboundProjectionEvidence(fixture.base, fixture.evidenceId, action, preview.consent);
    const destination = destinationFor(fixture, action);
    if (destination !== null) {
      assert.equal(readFileSync(join(fixture.rootPath, destination), "utf8"), REVIEWED);
    }
    assert.deepEqual(protocolArtifacts(fixture), []);
    assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
    assert.deepEqual(readIndex(fixture.base), []);
  });
}

test("degraded replay keeps a placeholder whose identity was never journaled (#2819)", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-2819-unjournaled-");
  t.after(() => cleanupFixture(fixture.base));

  // The placeholder was created but the write that would journal its
  // identity failed. Nothing proves it is protocol-owned, so it is kept and
  // listed (as the native restage does) while the discard itself completes.
  const guardPath = defaultResolutionPath(fixture, "guard");
  writeFileSync(join(fixture.rootPath, guardPath), "");
  seedResolving(fixture, "discard", {});

  const listed = loadUnboundProjectionEvidence(fixture.base);
  assert.deepEqual(listed.map((entry) => [entry.evidencePath, entry.kind, entry.transition]), [
    [guardPath, "quarantine", "retained"],
  ]);
  assert.equal(existsSync(join(fixture.rootPath, fixture.evidencePath)), false);
  assert.equal(existsSync(join(fixture.rootPath, guardPath)), true);

  // The kept placeholder is ordinary retained evidence, resolvable degraded.
  const preview = previewUnboundProjectionEvidenceResolution(fixture.base, listed[0]!.evidenceId, "discard");
  resolveUnboundProjectionEvidence(fixture.base, listed[0]!.evidenceId, "discard", preview.consent);
  assert.deepEqual(protocolArtifacts(fixture), []);
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
});

test("degraded replay finishes a prepared resolution whose bytes are mid-rotation in the guard (#2819)", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-2819-rotation-");
  t.after(() => cleanupFixture(fixture.base));

  // Windows rotation, interrupted after the evidence moved into the guard
  // slot: the evidence path is empty and the pivot holds the guard
  // placeholder. Only the digest says where the reviewed bytes are.
  const guardPath = defaultResolutionPath(fixture, "guard");
  const exchangePath = defaultResolutionPath(fixture, "exchange");
  writeFileSync(join(fixture.rootPath, exchangePath), "");
  const placeholderIdentity = identityOf(join(fixture.rootPath, exchangePath));
  renameSync(join(fixture.rootPath, fixture.evidencePath), join(fixture.rootPath, guardPath));
  seedResolving(fixture, "preserve", {
    guardIdentity: placeholderIdentity,
    exchangeIdentity: "1:1",
  });

  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(readFileSync(join(fixture.rootPath, preservedPath(fixture)), "utf8"), REVIEWED);
  assert.deepEqual(protocolArtifacts(fixture), []);
});

test("degraded replay finishes a prepared resolution whose exchange completed (#2819)", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-2819-exchanged-");
  t.after(() => cleanupFixture(fixture.base));

  // The exchange completed but the phase was never persisted: the evidence
  // path now holds the empty guard placeholder and the guard slot holds the
  // reviewed bytes.
  const guardPath = defaultResolutionPath(fixture, "guard");
  renameSync(join(fixture.rootPath, fixture.evidencePath), join(fixture.rootPath, guardPath));
  writeFileSync(join(fixture.rootPath, fixture.evidencePath), "");
  seedResolving(fixture, "restore", {
    guardIdentity: identityOf(join(fixture.rootPath, fixture.evidencePath)),
  });

  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.equal(readFileSync(join(fixture.rootPath, fixture.logicalPath), "utf8"), REVIEWED);
  assert.deepEqual(protocolArtifacts(fixture), []);
});

for (const phase of ["guarded", "published", "deleting"] as const) {
  test(`degraded replay finishes a ${phase} resolution whose bytes sit in the guard (#2819)`, (t) => {
    degradeForTest(t);
    const fixture = seedEvidenceFixture(`gsd-evidence-2819-${phase}-`);
    t.after(() => cleanupFixture(fixture.base));

    const guardPath = defaultResolutionPath(fixture, "guard");
    renameSync(join(fixture.rootPath, fixture.evidencePath), join(fixture.rootPath, guardPath));
    if (phase !== "guarded") {
      mkdirSync(dirname(join(fixture.rootPath, preservedPath(fixture))), { recursive: true });
      writeFileSync(join(fixture.rootPath, preservedPath(fixture)), REVIEWED);
    }
    seedResolving(fixture, "preserve", {
      guardIdentity: identityOf(join(fixture.rootPath, guardPath)),
      phase,
    });

    assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
    assert.equal(readFileSync(join(fixture.rootPath, preservedPath(fixture)), "utf8"), REVIEWED);
    assert.deepEqual(protocolArtifacts(fixture), []);
    assert.deepEqual(readIndex(fixture.base), []);
  });
}

test("degraded replay finishes a guard that holds a copy-fallback copy (#2819)", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-2819-copy-");
  t.after(() => cleanupFixture(fixture.base));

  // The copy fallback copied the bytes into the guard (a new identity) and
  // removed the source; finalising the copy never persisted.
  const guardPath = defaultResolutionPath(fixture, "guard");
  writeFileSync(join(fixture.rootPath, guardPath), REVIEWED);
  unlinkSync(join(fixture.rootPath, fixture.evidencePath));
  seedResolving(fixture, "discard", { guardIdentity: "1:1", exchangeIdentity: "2:2" });

  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
  assert.deepEqual(protocolArtifacts(fixture), []);
});

test("degraded replay returns a resolution it cannot finish to review (#2819)", (t) => {
  degradeForTest(t);
  const fixture = seedEvidenceFixture("gsd-evidence-2819-review-");
  t.after(() => cleanupFixture(fixture.base));

  // The bytes are in the guard but the restore destination now holds other
  // content: nothing may be overwritten, and replaying the same failure on
  // every open would be the wedge. The bytes go back to the evidence path
  // (same file, so an earlier review still describes them) for a new choice.
  const guardPath = defaultResolutionPath(fixture, "guard");
  const originalIdentity = identityOf(join(fixture.rootPath, fixture.evidencePath));
  renameSync(join(fixture.rootPath, fixture.evidencePath), join(fixture.rootPath, guardPath));
  writeFileSync(join(fixture.rootPath, fixture.logicalPath), "current render\n");
  seedResolving(fixture, "restore", {
    guardIdentity: identityOf(join(fixture.rootPath, guardPath)),
    phase: "guarded",
  });

  const listed = loadUnboundProjectionEvidence(fixture.base);
  assert.deepEqual(listed.map((entry) => [entry.evidenceId, entry.transition]), [[fixture.evidenceId, "retained"]]);
  assert.equal(listed[0]!.resolution, undefined);
  assert.equal(readFileSync(join(fixture.rootPath, fixture.evidencePath), "utf8"), REVIEWED);
  assert.equal(identityOf(join(fixture.rootPath, fixture.evidencePath)), originalIdentity);
  assert.equal(readFileSync(join(fixture.rootPath, fixture.logicalPath), "utf8"), "current render\n");
  assert.deepEqual(protocolArtifacts(fixture), [fixture.evidencePath]);

  const preview = previewUnboundProjectionEvidenceResolution(fixture.base, fixture.evidenceId, "preserve");
  resolveUnboundProjectionEvidence(fixture.base, fixture.evidenceId, "preserve", preview.consent);
  assert.equal(readFileSync(join(fixture.rootPath, preservedPath(fixture)), "utf8"), REVIEWED);
  assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
});

test("a re-occupied canonical path keeps both the moved bytes and the new content for review (#2819)", (t) => {
  degradeForTest(t);
  const base = mkdtempSync(join(tmpdir(), "gsd-evidence-2819-canonical-"));
  t.after(() => cleanupFixture(base));
  const rootPath = join(base, ".gsd");
  const logicalPath = "notes/result.md";
  mkdirSync(join(rootPath, "notes"), { recursive: true });
  mkdirSync(join(rootPath, "migration"), { recursive: true });
  const evidenceId = `evidence:sha256:${createHash("sha256")
    .update(JSON.stringify({ evidencePath: logicalPath, kind: "canonical", logicalPath, scope: "file" }))
    .digest("hex")}`;
  const fixture: EvidenceFixture = {
    base,
    rootPath,
    logicalPath,
    evidencePath: logicalPath,
    evidenceId,
    contentDigest: `sha256:${createHash("sha256").update(REVIEWED).digest("hex")}`,
    indexPath: join(rootPath, "migration", "unbound-projection-evidence.json"),
  };
  // The reviewed canonical bytes were moved into the guard; a new render then
  // landed at the projection path. Neither may be lost or silently accepted.
  const guardPath = defaultResolutionPath(fixture, "guard");
  writeFileSync(join(rootPath, guardPath), REVIEWED);
  writeFileSync(join(rootPath, logicalPath), "new render\n");
  writeFileSync(fixture.indexPath, `${JSON.stringify([{
    evidenceId,
    evidencePath: logicalPath,
    evidenceIdentity: identityOf(join(rootPath, guardPath)),
    contentDigest: fixture.contentDigest,
    kind: "canonical",
    logicalPath,
    scope: "file",
    transition: "retained",
  }])}\n`);
  seedResolving(fixture, "restore", {
    guardIdentity: identityOf(join(rootPath, guardPath)),
    phase: "guarded",
  });

  const listed = loadUnboundProjectionEvidence(base)
    .map((entry) => [entry.evidencePath, entry.kind, entry.transition, entry.contentDigest])
    .sort();
  assert.deepEqual(listed, [
    [guardPath, "quarantine", "retained", fixture.contentDigest],
    [logicalPath, "canonical", "retained", `sha256:${createHash("sha256").update("new render\n").digest("hex")}`],
  ].sort());
  assert.equal(readFileSync(join(rootPath, guardPath), "utf8"), REVIEWED);
  assert.equal(readFileSync(join(rootPath, logicalPath), "utf8"), "new render\n");

  // Same store, but the new render happens to be byte-identical to the
  // guarded bytes and the persisted action is discard: the guarded bytes are
  // the ones discarded, the fresh render at the projection path stays.
  writeFileSync(join(rootPath, logicalPath), REVIEWED);
  writeFileSync(fixture.indexPath, `${JSON.stringify([{
    evidenceId,
    evidencePath: logicalPath,
    evidenceIdentity: identityOf(join(rootPath, guardPath)),
    contentDigest: fixture.contentDigest,
    kind: "canonical",
    logicalPath,
    scope: "file",
    transition: "retained",
  }])}\n`);
  seedResolving(fixture, "discard", {
    guardIdentity: identityOf(join(rootPath, guardPath)),
    phase: "guarded",
  });
  assert.deepEqual(loadUnboundProjectionEvidence(base), []);
  assert.equal(existsSync(join(rootPath, guardPath)), false);
  assert.equal(readFileSync(join(rootPath, logicalPath), "utf8"), REVIEWED);
});

for (const copied of [false, true]) {
  test(`native replay finishes the deleting state degraded replay persists with ${copied ? "a copied" : "the moved"} guard (#2819)`, { skip: !nativeMode }, (t) => {
    const fixture = seedEvidenceFixture(`gsd-evidence-2819-native-deleting-${copied}-`);
    t.after(() => cleanupFixture(fixture.base));

    // If the degraded completion stops after persisting its deleting phase,
    // the native open that follows once the latch clears must finish it.
    const guardPath = defaultResolutionPath(fixture, "guard");
    if (copied) {
      writeFileSync(join(fixture.rootPath, guardPath), REVIEWED);
      unlinkSync(join(fixture.rootPath, fixture.evidencePath));
    } else {
      renameSync(join(fixture.rootPath, fixture.evidencePath), join(fixture.rootPath, guardPath));
    }
    seedResolving(fixture, "discard", {
      guardIdentity: identityOf(join(fixture.rootPath, guardPath)),
      ...(copied ? { resolvedViaCopyFallback: true } : {}),
      phase: "deleting",
    });

    assert.deepEqual(loadUnboundProjectionEvidence(fixture.base), []);
    assert.deepEqual(protocolArtifacts(fixture), []);
  });
}
