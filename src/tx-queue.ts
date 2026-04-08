/**
 * Disk-backed Transaction Write-Ahead Log (WAL).
 *
 * Tracks every transaction from build through confirmation to provide
 * crash resilience. If the middleware or Hydra node restarts, pending
 * transactions can be recovered and resubmitted.
 *
 * Each entry is a JSON file in `IPFS_STAGING_DIR/tx-queue/`.
 * State transitions: BUILT → SUBMITTED → ACCEPTED → CONFIRMED → APPLIED
 * Failed transactions: any state → FAILED
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TxState = 'BUILT' | 'SUBMITTED' | 'ACCEPTED' | 'CONFIRMED' | 'APPLIED' | 'FAILED';

export interface TxQueueEntry {
    /** Unique ID — voterId:nonce for votes, tokenName for burns. */
    id: string;
    /** Transaction type. */
    type: 'register' | 'vote-and-register' | 'cast_vote' | 'count_vote' | 'finalize';
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
// TxQueue
// ---------------------------------------------------------------------------

export class TxQueue {
    private readonly queueDir: string;
    private entries = new Map<string, TxQueueEntry>();
    private initialized = false;

    constructor(stagingDir: string) {
        this.queueDir = path.join(stagingDir, 'tx-queue');
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

    /** Write a new entry to disk and memory. */
    async enqueue(entry: Omit<TxQueueEntry, 'createdAt' | 'updatedAt'>): Promise<string> {
        const now = Date.now();
        const full: TxQueueEntry = { ...entry, createdAt: now, updatedAt: now };
        this.entries.set(full.id, full);
        await this.writeToDisk(full);
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

    async markSubmitted(id: string): Promise<void> { await this.updateState(id, 'SUBMITTED'); }
    async markAccepted(id: string): Promise<void> { await this.updateState(id, 'ACCEPTED'); }
    async markConfirmed(id: string): Promise<void> { await this.updateState(id, 'CONFIRMED'); }
    async markApplied(id: string): Promise<void> { await this.updateState(id, 'APPLIED'); }
    async markFailed(id: string, error: string): Promise<void> {
        await this.updateState(id, 'FAILED', { error });
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

    /** Get all entries in BUILT or SUBMITTED state (need to be sent/resent). */
    getPending(): TxQueueEntry[] {
        return [...this.entries.values()].filter(e => e.state === 'BUILT' || e.state === 'SUBMITTED');
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

    /** Check if a voter has any pending entries (for per-voter ordering). */
    hasVoterPending(voterId: string): boolean {
        for (const entry of this.entries.values()) {
            if (entry.voterId === voterId &&
                entry.state !== 'APPLIED' && entry.state !== 'FAILED' && entry.state !== 'CONFIRMED') {
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
        // Sanitize ID for filesystem
        const safe = id.replace(/[^a-zA-Z0-9_:-]/g, '_');
        return path.join(this.queueDir, `${safe}.json`);
    }

    private async writeToDisk(entry: TxQueueEntry): Promise<void> {
        await fs.writeFile(this.entryPath(entry.id), JSON.stringify(entry));
    }
}
