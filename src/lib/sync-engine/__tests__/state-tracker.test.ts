import { describe, expect, it } from 'vitest'

import { createStateTracker } from '../state-tracker'

describe('createStateTracker', () => {
    it('is never current against an empty remote snapshot', () => {
        const tracker = createStateTracker({ Email: 'a' })
        expect(tracker.isCurrent({})).toBe(false)
    })

    it('is not current before any state has been recorded', () => {
        const tracker = createStateTracker()
        expect(tracker.isCurrent({ Email: 'a', Mailbox: 'b' })).toBe(false)
    })

    it('is current when every remote state matches a recorded state', () => {
        const tracker = createStateTracker()
        tracker.recordStates({ Email: 'a', Mailbox: 'b' })
        expect(tracker.isCurrent({ Email: 'a', Mailbox: 'b' })).toBe(true)
    })

    it('is not current when any remote state differs', () => {
        const tracker = createStateTracker()
        tracker.recordStates({ Email: 'a', Mailbox: 'b' })
        expect(tracker.isCurrent({ Email: 'a', Mailbox: 'changed' })).toBe(false)
    })

    it('is not current when the remote has a type we have not recorded', () => {
        const tracker = createStateTracker()
        tracker.recordStates({ Email: 'a' })
        expect(tracker.isCurrent({ Email: 'a', Mailbox: 'b' })).toBe(false)
    })

    it('merges recorded states and resets cleanly', () => {
        const tracker = createStateTracker()
        tracker.recordStates({ Email: 'a' })
        tracker.recordStates({ Mailbox: 'b' })
        expect(tracker.snapshot()).toEqual({ Email: 'a', Mailbox: 'b' })

        tracker.reset()
        expect(tracker.snapshot()).toEqual({})
        expect(tracker.isCurrent({ Email: 'a' })).toBe(false)
    })
})
