import type { StateTracker, SyncStateSnapshot } from './state-tracker'

export type SyncOutcome = 'completed' | 'skipped-unchanged'

export type SyncCoordinator = {
    isSyncing(): boolean
    requestSync(reason: string): Promise<SyncOutcome>
}

/**
 * Coalesces sync triggers into at most one running sync plus one queued
 * follow-up, and skips the full sync entirely when the server state strings
 * match what we already have.
 */
export function createSyncCoordinator({
    checkRemoteStates,
    onEvent,
    performSync,
    stateTracker,
}: {
    checkRemoteStates: () => Promise<SyncStateSnapshot>
    onEvent?: (name: string, properties: Record<string, boolean | number | string>) => void
    performSync: () => Promise<SyncStateSnapshot>
    stateTracker: StateTracker
}): SyncCoordinator {
    let inFlight: Promise<SyncOutcome> | null = null
    let queued: Promise<SyncOutcome> | null = null

    async function runSync(reason: string): Promise<SyncOutcome> {
        const remoteStates = await checkRemoteStates()

        if (stateTracker.isCurrent(remoteStates)) {
            onEvent?.('sync-coordinator.skipped-unchanged', { reason })
            return 'skipped-unchanged'
        }

        const nextStates = await performSync()
        stateTracker.recordStates(nextStates)
        onEvent?.('sync-coordinator.completed', { reason })
        return 'completed'
    }

    function requestSync(reason: string): Promise<SyncOutcome> {
        if (inFlight) {
            if (!queued) {
                onEvent?.('sync-coordinator.queued', { reason })
                queued = inFlight
                    .catch(() => undefined)
                    .then(() => {
                        queued = null
                        return requestSync(`${reason}:queued`)
                    })
            } else {
                onEvent?.('sync-coordinator.coalesced', { reason })
            }

            return queued
        }

        inFlight = runSync(reason).finally(() => {
            inFlight = null
        })

        return inFlight
    }

    return {
        isSyncing() {
            return inFlight !== null
        },
        requestSync,
    }
}
