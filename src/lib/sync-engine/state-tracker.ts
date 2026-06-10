export type SyncStateSnapshot = Record<string, string>

export type StateTracker = {
    isCurrent(remote: SyncStateSnapshot): boolean
    recordStates(next: SyncStateSnapshot): void
    reset(): void
    snapshot(): SyncStateSnapshot
}

export function createStateTracker(initial: SyncStateSnapshot = {}): StateTracker {
    let states: SyncStateSnapshot = { ...initial }

    return {
        isCurrent(remote) {
            const types = Object.keys(remote)

            if (!types.length) {
                return false
            }

            return types.every((type) => states[type] !== undefined && states[type] === remote[type])
        },
        recordStates(next) {
            states = { ...states, ...next }
        },
        reset() {
            states = {}
        },
        snapshot() {
            return { ...states }
        },
    }
}
