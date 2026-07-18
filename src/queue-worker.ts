/**
 * Background queue worker for transaction dispatch.
 *
 * Watches the TxQueue for BUILT entries and submits them to the Hydra head
 * via WebSocket. Listens for TxValid/TxInvalid/SnapshotConfirmed to advance
 * entry states. Enforces ordering rules:
 *
 * - Global throttle: max ~100 txs in SUBMITTED+ACCEPTED state
 * - Per-voter ordering: same voter's txs dispatched sequentially
 * - Contention serialization: register/vote-and-register wait for SnapshotConfirmed
 * - Non-contending concurrency: cast_vote/count_vote dispatch in parallel
 */

import type { HydraMonitor } from '@lerna-labs/hydra-sdk';
import { TxQueue, isContending } from './tx-queue.js';
import type { TxQueueEntry } from './tx-queue.js';
import { debug } from './helpers.js';

const MAX_IN_FLIGHT = 100;
const MAX_RETRY_ATTEMPTS = 3;

/** Patterns indicating a retryable error (stale UTxO). */
function isRetryable(reason: string): boolean {
    const lower = reason.toLowerCase();
    return lower.includes('badinputsutxo') ||
        lower.includes('bad inputs') ||
        lower.includes('utxo') && lower.includes('not found') ||
        lower.includes('failed to resolve');
}

export class QueueWorker {
    private running = false;
    private dispatchTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly queue: TxQueue,
        private readonly monitor: HydraMonitor,
    ) {}

    /** Start the worker — attach WebSocket listener and begin dispatch loop. */
    start(): void {
        if (this.running) return;
        this.running = true;

        // Listen for Hydra head messages
        this.monitor.ws.on('message', (msg: any) => this.onMessage(msg));

        // Listen for new entries to trigger dispatch
        this.queue.on('enqueued', () => this.scheduleDispatch());

        // Process any existing BUILT entries from a previous session
        this.scheduleDispatch();

        debug('[queue-worker] Started');
    }

    /** Stop the worker. */
    stop(): void {
        this.running = false;
        if (this.dispatchTimer) {
            clearTimeout(this.dispatchTimer);
            this.dispatchTimer = null;
        }
        debug('[queue-worker] Stopped');
    }

    // ---------------------------------------------------------------------------
    // WebSocket message handler
    // ---------------------------------------------------------------------------

    private onMessage(msg: any): void {
        if (msg.tag === 'TxValid') {
            this.handleTxValid(msg.transactionId);
        } else if (msg.tag === 'TxInvalid') {
            const txId = msg.transaction?.txId ?? msg.txId ?? '';
            const reason = msg.validationError?.reason ?? 'unknown';
            this.handleTxInvalid(txId, reason);
        } else if (msg.tag === 'SnapshotConfirmed') {
            const confirmed: any[] = msg.snapshot?.confirmed ?? msg.confirmed ?? [];
            this.handleSnapshotConfirmed(confirmed);
        }
    }

    private async handleTxValid(transactionId: string): Promise<void> {
        const entry = this.queue.getByTxHash(transactionId);
        if (!entry || entry.state !== 'SUBMITTED') return;

        debug(`[queue-worker] TxValid: ${entry.id} (${transactionId.slice(0, 16)}…)`);
        await this.queue.markAccepted(entry.id);

        // For non-contending txs, ACCEPTED is sufficient — schedule more dispatches
        if (!isContending(entry.type)) {
            this.scheduleDispatch();
        }
    }

    private async handleTxInvalid(txId: string, reason: string): Promise<void> {
        const entry = this.queue.getByTxHash(txId);
        if (!entry || (entry.state !== 'SUBMITTED' && entry.state !== 'BUILT')) return;

        debug(`[queue-worker] TxInvalid: ${entry.id} — ${reason.slice(0, 100)}`);

        if (isRetryable(reason) && entry.attempts < MAX_RETRY_ATTEMPTS) {
            // Retryable error — back to BUILT for re-dispatch
            await this.queue.incrementAttempts(entry.id);
            await this.queue.markBuilt(entry.id);
            debug(`[queue-worker] Retrying ${entry.id} (attempt ${entry.attempts + 1})`);
        } else {
            await this.queue.markFailed(entry.id, reason);
        }

        this.scheduleDispatch();
    }

    private async handleSnapshotConfirmed(confirmed: any[]): Promise<void> {
        for (const tx of confirmed) {
            const txId = tx.txId;
            if (!txId) continue;

            const entry = this.queue.getByTxHash(txId);
            if (!entry || entry.state !== 'ACCEPTED') continue;

            debug(`[queue-worker] SnapshotConfirmed: ${entry.id}`);
            // Snapshot confirmation is the terminal head event for an entry —
            // mark APPLIED so cleanup can reap it and per-voter / contention
            // slots free up.
            await this.queue.markApplied(entry.id);

            // For contending txs, confirmation means we can dispatch the next one
            if (isContending(entry.type)) {
                this.scheduleDispatch();
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Dispatch loop
    // ---------------------------------------------------------------------------

    /** Schedule a dispatch check (debounced to avoid tight loops). */
    private scheduleDispatch(): void {
        if (!this.running) return;
        if (this.dispatchTimer) return; // already scheduled
        this.dispatchTimer = setTimeout(() => {
            this.dispatchTimer = null;
            this.dispatch().catch(err => {
                console.error('[queue-worker] Dispatch error:', err);
            });
        }, 10); // 10ms debounce
    }

    /** Main dispatch logic — pick eligible entries and submit to head. */
    private async dispatch(): Promise<void> {
        if (!this.running) return;

        const inFlight = this.queue.getInFlightToHead();
        if (inFlight >= MAX_IN_FLIGHT) {
            debug(`[queue-worker] Throttled: ${inFlight} in-flight (max ${MAX_IN_FLIGHT})`);
            return;
        }

        const built = this.queue.getBuilt();
        if (built.length === 0) return;

        // Sort: non-contending first (can batch), contending last (serial)
        built.sort((a, b) => {
            const ac = isContending(a.type) ? 1 : 0;
            const bc = isContending(b.type) ? 1 : 0;
            return ac - bc || a.createdAt - b.createdAt;
        });

        let dispatched = 0;
        const budget = MAX_IN_FLIGHT - inFlight;

        for (const entry of built) {
            if (dispatched >= budget) break;

            // Per-voter ordering: another entry from this voter is still
            // processing (BUILT/SUBMITTED/ACCEPTED) — wait for it to finish
            // so we don't reference a stale UTxO.
            if (entry.voterId && this.queue.hasVoterActiveExcept(entry.voterId, entry.id)) {
                continue;
            }

            // Contention serialization: only one contending tx at a time
            if (isContending(entry.type) && this.queue.hasContendingInFlight()) {
                continue; // wait for current contending tx to confirm
            }

            // Submit to head via WebSocket
            await this.submitEntry(entry);
            dispatched++;
        }

        // If we dispatched something and there's still budget, check again
        if (dispatched > 0 && dispatched < budget && this.queue.getBuilt().length > 0) {
            this.scheduleDispatch();
        }
    }

    /** Submit a single entry to the Hydra head via WebSocket. */
    private async submitEntry(entry: TxQueueEntry): Promise<void> {
        try {
            this.monitor.ws.send({
                tag: 'NewTx',
                transaction: {
                    type: 'Witnessed Tx ConwayEra' as const,
                    description: '',
                    cborHex: entry.signedCborHex,
                },
            });
            await this.queue.markSubmitted(entry.id);
            debug(`[queue-worker] Submitted: ${entry.id} (${entry.txHash.slice(0, 16)}…)`);
        } catch (err: any) {
            console.error(`[queue-worker] Submit failed for ${entry.id}:`, err.message);
            // Don't mark as failed — leave as BUILT for retry on next dispatch
        }
    }

    // ---------------------------------------------------------------------------
    // Recovery — reconcile queue state against head snapshot
    // ---------------------------------------------------------------------------

    /**
     * Reconcile in-flight entries against the current head snapshot.
     * Called on startup and on HydraMonitor reconnect.
     */
    async reconcile(getSnapshotUtxo: () => Promise<Record<string, any>>): Promise<{ reconciled: number; resubmitted: number }> {
        const pending = this.queue.getPending();
        const accepted = this.queue.getAccepted();
        if (pending.length === 0 && accepted.length === 0) {
            return { reconciled: 0, resubmitted: 0 };
        }

        debug(`[queue-worker] Reconciling: ${pending.length} pending, ${accepted.length} accepted`);

        let reconciled = 0;
        let resubmitted = 0;

        try {
            const snapshot = await getSnapshotUtxo();

            // Check SUBMITTED and ACCEPTED entries against snapshot
            for (const entry of [...pending, ...accepted]) {
                if (entry.state === 'BUILT') {
                    // Never sent — worker will pick it up naturally
                    resubmitted++;
                    continue;
                }

                // For SUBMITTED/ACCEPTED: check if the tx's effect is visible in snapshot
                // This is a best-effort check — we look for the voter token
                // TODO: more precise check based on tx type
                const found = this.checkEntryInSnapshot(entry, snapshot);
                if (found) {
                    await this.queue.markConfirmed(entry.id);
                    reconciled++;
                    debug(`[queue-worker] Reconciled ${entry.id} — found in snapshot`);
                } else {
                    // Not in snapshot — resubmit
                    await this.queue.markBuilt(entry.id);
                    resubmitted++;
                    debug(`[queue-worker] Resubmitting ${entry.id} — not in snapshot`);
                }
            }
        } catch (err: any) {
            console.error('[queue-worker] Reconciliation error:', err.message);
        }

        return { reconciled, resubmitted };
    }

    /**
     * Did this entry's tx land? Reconcile only needs to know whether the tx
     * produced any still-live output, not which one — our txs create at most two
     * outputs (voter token + admin change), both under this txHash. A ref is
     * `txHash#outputIndex`; compare the txHash segment exactly so the match can't
     * depend on hash length or a shared prefix.
     */
    private checkEntryInSnapshot(entry: TxQueueEntry, snapshot: Record<string, any>): boolean {
        for (const ref of Object.keys(snapshot)) {
            if (ref.split('#', 1)[0] === entry.txHash) return true;
        }
        return false;
    }
}
