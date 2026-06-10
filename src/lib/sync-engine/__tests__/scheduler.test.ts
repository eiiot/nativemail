import { describe, expect, it } from 'vitest'

import { createRequestScheduler } from '../scheduler'

function createDeferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve
        reject = promiseReject
    })
    return { promise, reject, resolve }
}

async function flushMicrotasks() {
    for (let index = 0; index < 5; index += 1) {
        await Promise.resolve()
    }
}

describe('createRequestScheduler', () => {
    it('runs tasks immediately while under the concurrency cap', async () => {
        const scheduler = createRequestScheduler({ maxConcurrent: 2 })
        let started = 0
        const gate = createDeferred<void>()

        const tasks = [1, 2].map(() =>
            scheduler.schedule(async () => {
                started += 1
                await gate.promise
                return 'done'
            })
        )

        await flushMicrotasks()
        expect(started).toBe(2)

        gate.resolve()
        await Promise.all(tasks)
    })

    it('queues tasks beyond the cap and starts them as slots free up', async () => {
        const scheduler = createRequestScheduler({ maxConcurrent: 1 })
        const first = createDeferred<void>()
        let secondStarted = false

        const firstTask = scheduler.schedule(async () => {
            await first.promise
        })
        const secondTask = scheduler.schedule(async () => {
            secondStarted = true
        })

        await flushMicrotasks()
        expect(secondStarted).toBe(false)
        expect(scheduler.stats()).toEqual({ pending: 1, running: 1 })

        first.resolve()
        await Promise.all([firstTask, secondTask])
        expect(secondStarted).toBe(true)
        expect(scheduler.stats()).toEqual({ pending: 0, running: 0 })
    })

    it('starts higher-priority tasks before lower-priority ones queued earlier', async () => {
        const scheduler = createRequestScheduler({ maxConcurrent: 1 })
        const gate = createDeferred<void>()
        const order: string[] = []

        const blocker = scheduler.schedule(async () => {
            await gate.promise
        })
        const prefetch = scheduler.schedule(
            async () => {
                order.push('prefetch')
            },
            { priority: 'prefetch' }
        )
        const foreground = scheduler.schedule(
            async () => {
                order.push('foreground')
            },
            { priority: 'foreground' }
        )

        gate.resolve()
        await Promise.all([blocker, prefetch, foreground])
        expect(order).toEqual(['foreground', 'prefetch'])
    })

    it('preserves enqueue order within the same priority', async () => {
        const scheduler = createRequestScheduler({ maxConcurrent: 1 })
        const gate = createDeferred<void>()
        const order: number[] = []

        const blocker = scheduler.schedule(async () => {
            await gate.promise
        })
        const queued = [1, 2, 3].map((value) =>
            scheduler.schedule(async () => {
                order.push(value)
            })
        )

        gate.resolve()
        await Promise.all([blocker, ...queued])
        expect(order).toEqual([1, 2, 3])
    })

    it('joins concurrent schedules with the same key into a single run', async () => {
        const scheduler = createRequestScheduler({ maxConcurrent: 4 })
        const gate = createDeferred<string>()
        let runs = 0

        const run = () => {
            runs += 1
            return gate.promise
        }

        const first = scheduler.schedule(run, { key: 'mailboxes' })
        const second = scheduler.schedule(run, { key: 'mailboxes' })

        gate.resolve('result')
        const [firstResult, secondResult] = await Promise.all([first, second])

        expect(runs).toBe(1)
        expect(firstResult).toBe('result')
        expect(secondResult).toBe('result')
    })

    it('propagates a failure to every joined caller', async () => {
        const scheduler = createRequestScheduler()
        const gate = createDeferred<never>()

        const first = scheduler.schedule(() => gate.promise, { key: 'shared' })
        const second = scheduler.schedule(() => gate.promise, { key: 'shared' })

        gate.reject(new Error('boom'))

        await expect(first).rejects.toThrow('boom')
        await expect(second).rejects.toThrow('boom')
    })

    it('releases the key once the task settles so later calls run again', async () => {
        const scheduler = createRequestScheduler()
        let runs = 0

        await scheduler.schedule(
            async () => {
                runs += 1
            },
            { key: 'repeat' }
        )
        await scheduler.schedule(
            async () => {
                runs += 1
            },
            { key: 'repeat' }
        )

        expect(runs).toBe(2)
    })

    it('rejects a queued task without running it when every signal is aborted', async () => {
        const scheduler = createRequestScheduler({ maxConcurrent: 1 })
        const gate = createDeferred<void>()
        const controller = new AbortController()
        let ran = false

        const blocker = scheduler.schedule(async () => {
            await gate.promise
        })
        const aborted = scheduler.schedule(
            async () => {
                ran = true
            },
            { signal: controller.signal }
        )

        controller.abort()
        gate.resolve()

        await blocker
        await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
        expect(ran).toBe(false)
    })

    it('still runs a queued task when only one of the joined signals aborts', async () => {
        const scheduler = createRequestScheduler({ maxConcurrent: 1 })
        const gate = createDeferred<void>()
        const abortingController = new AbortController()
        let ran = false

        const blocker = scheduler.schedule(async () => {
            await gate.promise
        })
        const run = async () => {
            ran = true
            return 'ok'
        }
        const first = scheduler.schedule(run, { key: 'joined', signal: abortingController.signal })
        const second = scheduler.schedule(run, { key: 'joined' })

        abortingController.abort()
        gate.resolve()

        await blocker
        await expect(first).resolves.toBe('ok')
        await expect(second).resolves.toBe('ok')
        expect(ran).toBe(true)
    })
})
