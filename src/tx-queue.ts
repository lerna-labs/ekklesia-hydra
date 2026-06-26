/**
 * Disk-backed Transaction Write-Ahead Log (WAL) with EventEmitter.
 *
 * Tracks every transaction from build through confirmation to provide
 * crash resilience. Emits events so HTTP handlers can wait for TxValid
 * and the queue worker can react to state changes.
 *
 * Each entry is a JSON file in `IPFS_STAGING_DIR/tx-queue/`.
 * State transitions: BUILT → SUBMITTED → ACCEPTED → CONFIRMED → APPLIED
 * Failed transactions: any state → FAILED
 * Retry: FAILED/SUBMITTED → BUILT (for retryable errors)
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TxState = 'BUILT' | 'SUBMITTED' | 'ACCEPTED' | 'CONFIRMED' | 'APPLIED' | 'FAILED';

export type TxType = 'register' | 'vote-and-register' | 'cast_vote' | 'count_vote' | 'finalize' | 'prime';

/** Whether a tx type contends on the shared ballot token UTxO. */
export function isContending(type: TxType): boolean {
    return type === 'register' || type === 'vote-and-register' || type === 'finalize' || type === 'prime';
}

export interface TxQueueEntry {
    /** Unique ID — voterId:nonce for votes, tokenName for burns. */
    id: string;
    /** Transaction type. */
    type: TxType;
    /** Current lifecycle state. */
    state: TxState;
    /** Computed tx hash (blake2b-256 of tx body). */
    txHash: string;
    /** Signed CBOR hex — can be resubmitted on recovery. */
    signedCborHex: string;
    /** Voter ID (for per-voter ordering). */
    voterId?: string;
    /** Timestamp when entry was created. */
    createdAt: number;
    /** Timestamp of last state update. */
    updatedAt: number;
    /** Error reason if state === FAILED. */
    error?: string;
    /** Number of submission attempts. */
    attempts: number;
}

// ---------------------------------------------------------------------------
// TxQueue Events
// ---------------------------------------------------------------------------

export interface TxQueueEvents {
    /** Entry reached ACCEPTED state (TxValid received). */
    accepted: (data: { id: string; txHash: string }) => void;
    /** Entry reached FAILED state. */
    failed: (data: { id: string; error: string }) => void;
    /** Entry reached CONFIRMED state (SnapshotConfirmed). */
    confirmed: (data: { id: string; txHash: string }) => void;
    /** Entry reached APPLIED state — its tx is in a confirmed head snapshot. */
    applied: (data: { id: string; txHash: string }) => void;
    /** New entry enqueued in BUILT state — signals worker to check for work. */
    enqueued: (data: { id: string }) => void;
}

// ---------------------------------------------------------------------------
// TxQueue
// ---------------------------------------------------------------------------

export class TxQueue extends EventEmitter {
    private readonly queueDir: string;
    private entries = new Map<string, TxQueueEntry>();
    private initialized = false;

    constructor(stagingDir: string) {
        super();
        this.queueDir = path.join(stagingDir, 'tx-queue');
        // Burst burns enqueue thousands of waitForAcceptance listeners.
        // The default 10 produces noisy MaxListenersExceededWarning.
        this.setMaxListeners(0);
    }

    /** Initialize: ensure directory exists and load existing entries from disk. */
    async init(): Promise<void> {
        await fs.mkdir(this.queueDir, { recursive: true });
        try {
            const files = await fs.readdir(this.queueDir);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const raw = await fs.readFile(path.join(this.queueDir, file), 'utf-8');
                    const entry: TxQueueEntry = JSON.parse(raw);
                    this.entries.set(entry.id, entry);
                } catch { /* skip corrupt files */ }
            }
        } catch { /* directory may not exist yet */ }
        this.initialized = true;
    }

    /** Write a new entry to disk and memory. Emits 'enqueued'. */
    async enqueue(entry: Omit<TxQueueEntry, 'createdAt' | 'updatedAt'>): Promise<string> {
        const now = Date.now();
        const full: TxQueueEntry = { ...entry, createdAt: now, updatedAt: now };
        this.entries.set(full.id, full);
        await this.writeToDisk(full);
        this.emit('enqueued', { id: full.id });
        return full.id;
    }

    /** Update an entry's state. */
    private async updateState(id: string, state: TxState, extra?: Partial<TxQueueEntry>): Promise<void> {
        const entry = this.entries.get(id);
        if (!entry) return;
        entry.state = state;
        entry.updatedAt = Date.now();
        if (extra) Object.assign(entry, extra);
        await this.writeToDisk(entry);
    }

    async markBuilt(id: string): Promise<void> {
        await this.updateState(id, 'BUILT');
        this.emit('enqueued', { id }); // signal worker to re-check
    }
    async markSubmitted(id: string): Promise<void> { await this.updateState(id, 'SUBMITTED'); }
    async markAccepted(id: string): Promise<void> {
        const entry = this.entries.get(id);
        await this.updateState(id, 'ACCEPTED');
        if (entry) this.emit('accepted', { id, txHash: entry.txHash });
    }
    async markConfirmed(id: string): Promise<void> {
        const entry = this.entries.get(id);
        await this.updateState(id, 'CONFIRMED');
        if (entry) this.emit('confirmed', { id, txHash: entry.txHash });
    }
    async markApplied(id: string): Promise<void> {
        const entry = this.entries.get(id);
        await this.updateState(id, 'APPLIED');
        if (entry) this.emit('applied', { id, txHash: entry.txHash });
    }
    async markFailed(id: string, error: string): Promise<void> {
        await this.updateState(id, 'FAILED', { error });
        this.emit('failed', { id, error });
    }

    /** Increment attempt count. */
    async incrementAttempts(id: string): Promise<void> {
        const entry = this.entries.get(id);
        if (!entry) return;
        entry.attempts++;
        entry.updatedAt = Date.now();
        await this.writeToDisk(entry);
    }

    // ---------------------------------------------------------------------------
    // Wait helpers — for HTTP handlers to await state transitions
    // ---------------------------------------------------------------------------

    /**
     * Wait for an entry to reach ACCEPTED state (TxValid received).
     * Resolves with txHash. Rejects on FAILED or timeout.
     */
    waitForAcceptance(id: string, timeoutMs = 120_000): Promise<{ txHash: string }> {
        const entry = this.entries.get(id);
        // Already in terminal state?
        if (entry?.state === 'ACCEPTED' || entry?.state === 'CONFIRMED' || entry?.state === 'APPLIED') {
            return Promise.resolve({ txHash: entry.txHash });
        }
        if (entry?.state === 'FAILED') {
            return Promise.reject(new Error(entry.error ?? 'Transaction failed'));
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                this.removeListener('accepted', onAccepted);
                this.removeListener('failed', onFailed);
            };
            const settle = (fn: Function, value: any) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                cleanup();
                fn(value);
            };

            const timer = setTimeout(() => {
                settle(reject, new Error(`Timeout waiting for TxValid on entry ${id}`));
            }, timeoutMs);

            const onAccepted = (data: { id: string; txHash: string }) => {
                if (data.id === id) settle(resolve, { txHash: data.txHash });
            };
            const onFailed = (data: { id: string; error: string }) => {
                if (data.id === id) settle(reject, new Error(data.error));
            };

            this.on('accepted', onAccepted);
            this.on('failed', onFailed);
        });
    }

    /**
     * Wait for an entry to reach APPLIED state — i.e. its tx is in a confirmed
     * head snapshot (SnapshotConfirmed), not merely seen (TxValid). Resolves with
     * txHash. Rejects on FAILED or timeout.
     *
     * Settlement uses this so a finalize tx is provably in a confirmed snapshot
     * before the head is closed; otherwise Close would post the prior confirmed
     * snapshot to L1 and fan out a stale (601) BallotResult datum (audit F-015).
     */
    waitForApplied(id: string, timeoutMs = 120_000): Promise<{ txHash: string }> {
        const entry = this.entries.get(id);
        if (entry?.state === 'APPLIED') {
            return Promise.resolve({ txHash: entry.txHash });
        }
        if (entry?.state === 'FAILED') {
            return Promise.reject(new Error(entry.error ?? 'Transaction failed'));
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                this.removeListener('applied', onApplied);
                this.removeListener('failed', onFailed);
            };
            const settle = (fn: Function, value: any) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                cleanup();
                fn(value);
            };

            const timer = setTimeout(() => {
                settle(reject, new Error(`Timeout waiting for SnapshotConfirmed on entry ${id}`));
            }, timeoutMs);

            const onApplied = (data: { id: string; txHash: string }) => {
                if (data.id === id) settle(resolve, { txHash: data.txHash });
            };
            const onFailed = (data: { id: string; error: string }) => {
                if (data.id === id) settle(reject, new Error(data.error));
            };

            this.on('applied', onApplied);
            this.on('failed', onFailed);
        });
    }

    // ---------------------------------------------------------------------------
    // Queries
    // ---------------------------------------------------------------------------

    /** Get entry by ID. */
    get(id: string): TxQueueEntry | undefined {
        return this.entries.get(id);
    }

    /** Get entry by tx hash. */
    getByTxHash(txHash: string): TxQueueEntry | undefined {
        for (const entry of this.entries.values()) {
            if (entry.txHash === txHash) return entry;
        }
        return undefined;
    }

    /** Get all entries in BUILT state (ready to dispatch). */
    getBuilt(): TxQueueEntry[] {
        return [...this.entries.values()].filter(e => e.state === 'BUILT');
    }

    /** Get all entries in BUILT or SUBMITTED state (need to be sent/resent). */
    getPending(): TxQueueEntry[] {
        return [...this.entries.values()].filter(e => e.state === 'BUILT' || e.state === 'SUBMITTED');
    }

    /** Get all entries in SUBMITTED state (sent but not yet TxValid). */
    getSubmitted(): TxQueueEntry[] {
        return [...this.entries.values()].filter(e => e.state === 'SUBMITTED');
    }

    /** Get all entries in ACCEPTED state (TxValid received but not snapshot-confirmed). */
    getAccepted(): TxQueueEntry[] {
        return [...this.entries.values()].filter(e => e.state === 'ACCEPTED');
    }

    /** Get all entries in CONFIRMED state (snapshot confirmed but cache not updated). */
    getConfirmed(): TxQueueEntry[] {
        return [...this.entries.values()].filter(e => e.state === 'CONFIRMED');
    }

    /** Get all in-flight entries (not yet APPLIED or FAILED). */
    getInFlight(): TxQueueEntry[] {
        return [...this.entries.values()].filter(e =>
            e.state !== 'APPLIED' && e.state !== 'FAILED',
        );
    }

    /** Count entries in SUBMITTED + ACCEPTED state (in-flight to head). */
    getInFlightToHead(): number {
        let count = 0;
        for (const entry of this.entries.values()) {
            if (entry.state === 'SUBMITTED' || entry.state === 'ACCEPTED') count++;
        }
        return count;
    }

    /** Check if a voter has any active (non-terminal) entries. */
    hasVoterActive(voterId: string): boolean {
        for (const entry of this.entries.values()) {
            if (entry.voterId === voterId &&
                entry.state !== 'APPLIED' && entry.state !== 'FAILED') {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if a voter has any active entries OTHER than the given entry.
     * Used by the worker's per-voter dispatch ordering check.
     */
    hasVoterActiveExcept(voterId: string, exceptEntryId: string): boolean {
        for (const entry of this.entries.values()) {
            if (entry.voterId === voterId &&
                entry.id !== exceptEntryId &&
                entry.state !== 'APPLIED' && entry.state !== 'FAILED') {
                return true;
            }
        }
        return false;
    }

    /** Check if any contending tx (register/vote-and-register/finalize) is in-flight. */
    hasContendingInFlight(): boolean {
        for (const entry of this.entries.values()) {
            if (isContending(entry.type) &&
                (entry.state === 'SUBMITTED' || entry.state === 'ACCEPTED')) {
                return true;
            }
        }
        return false;
    }

    /** True when zero entries are in active processing states. */
    isDrained(): boolean {
        return this.getInFlight().length === 0;
    }

    /** Wait until all entries reach APPLIED or FAILED. */
    async drain(timeoutMs = 600_000): Promise<void> {
        const start = Date.now();
        while (!this.isDrained()) {
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Queue drain timed out after ${timeoutMs}ms — ${this.getInFlight().length} entries still in-flight`);
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }

    /** Get queue status summary. */
    status(): { built: number; submitted: number; accepted: number; confirmed: number; applied: number; failed: number; total: number } {
        const counts = { built: 0, submitted: 0, accepted: 0, confirmed: 0, applied: 0, failed: 0, total: 0 };
        for (const entry of this.entries.values()) {
            counts.total++;
            switch (entry.state) {
                case 'BUILT': counts.built++; break;
                case 'SUBMITTED': counts.submitted++; break;
                case 'ACCEPTED': counts.accepted++; break;
                case 'CONFIRMED': counts.confirmed++; break;
                case 'APPLIED': counts.applied++; break;
                case 'FAILED': counts.failed++; break;
            }
        }
        return counts;
    }

    // ---------------------------------------------------------------------------
    // Cleanup
    // ---------------------------------------------------------------------------

    /** Remove APPLIED and FAILED entries older than maxAgeMs. */
    async cleanup(maxAgeMs = 3600_000): Promise<number> {
        const cutoff = Date.now() - maxAgeMs;
        let removed = 0;
        for (const [id, entry] of this.entries) {
            if ((entry.state === 'APPLIED' || entry.state === 'FAILED') && entry.updatedAt < cutoff) {
                this.entries.delete(id);
                try { await fs.rm(this.entryPath(id)); } catch { /* ignore */ }
                removed++;
            }
        }
        return removed;
    }

    /** Clear all entries (used on head session reset). */
    async clear(): Promise<void> {
        this.entries.clear();
        try { await fs.rm(this.queueDir, { recursive: true, force: true }); } catch { /* ignore */ }
        await fs.mkdir(this.queueDir, { recursive: true });
    }

    // ---------------------------------------------------------------------------
    // Disk I/O
    // ---------------------------------------------------------------------------

    private entryPath(id: string): string {
        const safe = id.replace(/[^a-zA-Z0-9_:-]/g, '_');
        return path.join(this.queueDir, `${safe}.json`);
    }

    private async writeToDisk(entry: TxQueueEntry): Promise<void> {
        await fs.writeFile(this.entryPath(entry.id), JSON.stringify(entry));
    }
}
