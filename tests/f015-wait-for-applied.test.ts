/**
 * Regression coverage for audit finding F-015: the finalize datum write must be
 * in a confirmed head snapshot (SnapshotConfirmed → APPLIED) before the head is
 * closed. Otherwise Close posts the prior confirmed snapshot to L1 and fanout
 * reproduces a stale (601) BallotResult datum.
 *
 * The mechanism is `TxQueue.waitForApplied`, which settlement awaits after every
 * finalize enqueue (the deprecated monolithic `/settle` was the deterministic
 * case — it drove Close immediately after finalize TxValid). Before this, only
 * `waitForAcceptance` existed (resolves on TxValid), and `markApplied` emitted no
 * event, so nothing could block on snapshot confirmation.
 *
 * These tests exercise the queue in isolation (no Hydra/IPFS/server). The live
 * close ordering is covered by e2e; this guards the unit contract.
 */

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TxQueue } from '../src/tx-queue.js';

let dir: string;
let q: TxQueue;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'f015-queue-'));
    q = new TxQueue(dir);
    await q.init();
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

async function enqueueFinalize(id = 'finalize:tok') {
    await q.enqueue({ id, type: 'finalize', state: 'BUILT', txHash: 'a'.repeat(64), signedCborHex: 'aa', attempts: 0 });
    return id;
}

describe('F-015 — waitForApplied (finalize confirmed before close)', () => {
    it('resolves only once the entry reaches APPLIED, not at ACCEPTED', async () => {
        const id = await enqueueFinalize();
        await q.markAccepted(id);

        let resolved = false;
        const pending = q.waitForApplied(id, 5_000).then((r) => { resolved = true; return r; });

        // ACCEPTED (TxValid) is not enough — must still be waiting.
        await Promise.resolve();
        expect(resolved).toBe(false);

        await q.markApplied(id);
        const result = await pending;
        expect(resolved).toBe(true);
        expect(result.txHash).toBe('a'.repeat(64));
    });

    it('resolves immediately if the entry is already APPLIED', async () => {
        const id = await enqueueFinalize();
        await q.markAccepted(id);
        await q.markApplied(id);
        await expect(q.waitForApplied(id, 5_000)).resolves.toMatchObject({ txHash: 'a'.repeat(64) });
    });

    it('rejects if the entry fails', async () => {
        const id = await enqueueFinalize();
        const pending = q.waitForApplied(id, 5_000);
        await q.markFailed(id, 'boom');
        await expect(pending).rejects.toThrow('boom');
    });

    it('rejects on timeout if no snapshot confirmation arrives', async () => {
        const id = await enqueueFinalize();
        await q.markAccepted(id);
        await expect(q.waitForApplied(id, 20)).rejects.toThrow(/SnapshotConfirmed/);
    });

    it('markApplied emits an applied event with the txHash', async () => {
        const id = await enqueueFinalize();
        await q.markAccepted(id);
        const seen = new Promise<{ id: string; txHash: string }>((resolve) => q.once('applied', resolve));
        await q.markApplied(id);
        expect(await seen).toEqual({ id, txHash: 'a'.repeat(64) });
    });
});
