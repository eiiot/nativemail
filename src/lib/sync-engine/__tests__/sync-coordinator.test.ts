import { describe, expect, it } from 'vitest'

import { createStateTracker, type SyncStateSnapshot } from '../state-tracker'
import { createSyncCoordinator } from '../sync-coordinator'

function createDeferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve
        reject = promiseReject
    })
    return { promise, reject, resolve }
}

describe('createSyncCoordinator', () => {
    it('syncs on the first request and records the new states', async () => {
        const tracker = createStateTracker()
        let syncs = 0
        const coordinator = createSyncCoordinator({
            checkRemoteStates: async () => ({ Email: 'e1', Mailbox: 'm1' }),
            performSync: async () => {
                syncs += 1
                return { Email: 'e1', Mailbox: 'm1' }
            },
            stateTracker: tracker,
        })

        await expect(coordinator.requestSync('startup')).resolves.toBe('completed')
        expect(syncs).toBe(1)
        expect(tracker.snapshot()).toEqual({ Email: 'e1', Mailbox: 'm1' })
    })

    it('skips the full sync when the remote states are unchanged', async () => {
        const tracker = createStateTracker({ Email: 'e1', Mailbox: 'm1' })
        let syncs = 0
        const coordinator = createSyncCoordinator({
            checkRemoteStates: async () => ({ Email: 'e1', Mailbox: 'm1' }),
            performSync: async () => {
                syncs += 1
                return {}
            },
            stateTracker: tracker,
        })

        await expect(coordinator.requestSync('notification')).resolves.toBe('skipped-unchanged')
        expect(syncs).toBe(0)
    })

    it('coalesces triggers that arrive while a sync is running into one follow-up', async () => {
        const tracker = createStateTracker()
        const firstSync = createDeferred<SyncStateSnapshot>()
        let syncs = 0
        let remoteState = 'e1'
        const coordinator = createSyncCoordinator({
            checkRemoteStates: async () => ({ Email: remoteState }),
            performSync: async () => {
                syncs += 1
                if (syncs === 1) {
                    return firstSync.promise
                }
                return { Email: remoteState }
            },
            stateTracker: tracker,
        })

        const first = coordinator.requestSync('startup')
        const second = coordinator.requestSync('pull-refresh')
        const third = coordinator.requestSync('notification')

        expect(coordinator.isSyncing()).toBe(true)
        remoteState = 'e2'
        firstSync.resolve({ Email: 'e1' })

        await expect(first).resolves.toBe('completed')
        await expect(second).resolves.toBe('completed')
        await expect(third).resolves.toBe('completed')
        expect(syncs).toBe(2)
        expect(coordinator.isSyncing()).toBe(false)
    })

    it('lets the queued follow-up skip when nothing changed', async () => {
        const tracker = createStateTracker()
        const firstSync = createDeferred<SyncStateSnapshot>()
        let syncs = 0
        const coordinator = createSyncCoordinator({
            checkRemoteStates: async () => ({ Email: 'e1' }),
            performSync: async () => {
                syncs += 1
                return firstSync.promise
            },
            stateTracker: tracker,
        })

        const first = coordinator.requestSync('startup')
        const second = coordinator.requestSync('focus')

        firstSync.resolve({ Email: 'e1' })

        await expect(first).resolves.toBe('completed')
        await expect(second).resolves.toBe('skipped-unchanged')
        expect(syncs).toBe(1)
    })

    it('recovers after a failed sync and allows the next request to run', async () => {
        const tracker = createStateTracker()
        let attempts = 0
        const coordinator = createSyncCoordinator({
            checkRemoteStates: async () => ({ Email: 'e1' }),
            performSync: async () => {
                attempts += 1
                if (attempts === 1) {
                    throw new Error('network down')
                }
                return { Email: 'e1' }
            },
            stateTracker: tracker,
        })

        await expect(coordinator.requestSync('startup')).rejects.toThrow('network down')
        expect(coordinator.isSyncing()).toBe(false)
        await expect(coordinator.requestSync('retry')).resolves.toBe('completed')
    })

    it('still runs the queued follow-up when the first sync fails', async () => {
        const tracker = createStateTracker()
        const firstSync = createDeferred<SyncStateSnapshot>()
        let syncs = 0
        const coordinator = createSyncCoordinator({
            checkRemoteStates: async () => ({ Email: 'e1' }),
            performSync: async () => {
                syncs += 1
                if (syncs === 1) {
                    return firstSync.promise
                }
                return { Email: 'e1' }
            },
            stateTracker: tracker,
        })

        const first = coordinator.requestSync('startup')
        const second = coordinator.requestSync('pull-refresh')

        firstSync.reject(new Error('boom'))

        await expect(first).rejects.toThrow('boom')
        await expect(second).resolves.toBe('completed')
        expect(syncs).toBe(2)
    })
})
