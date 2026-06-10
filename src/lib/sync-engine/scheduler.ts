export type SchedulerPriority = 'foreground' | 'mutation' | 'metadata' | 'prefetch'

export type SchedulerEventProperties = Record<string, boolean | number | string>

export type ScheduleOptions = {
    key?: string
    priority?: SchedulerPriority
    signal?: AbortSignal
}

export type RequestScheduler = {
    schedule<T>(run: () => Promise<T>, options?: ScheduleOptions): Promise<T>
    stats(): { pending: number; running: number }
}

const priorityRank: Record<SchedulerPriority, number> = {
    foreground: 0,
    mutation: 1,
    metadata: 2,
    prefetch: 3,
}

type ScheduledTask = {
    enqueuedAt: number
    key: string | null
    priority: SchedulerPriority
    reject: (error: unknown) => void
    resolve: (value: unknown) => void
    run: () => Promise<unknown>
    sequence: number
    signals: AbortSignal[]
    waiters: number
}

function createAbortError(): Error {
    const error = new Error('Scheduled request aborted before it started')
    error.name = 'AbortError'
    return error
}

export function createRequestScheduler({
    maxConcurrent = 3,
    now = Date.now,
    onEvent,
}: {
    maxConcurrent?: number
    now?: () => number
    onEvent?: (name: string, properties: SchedulerEventProperties) => void
} = {}): RequestScheduler {
    const queue: ScheduledTask[] = []
    const inFlightByKey = new Map<string, { promise: Promise<unknown>; task: ScheduledTask | null }>()
    let running = 0
    let sequence = 0

    function emit(name: string, properties: SchedulerEventProperties) {
        onEvent?.(name, properties)
    }

    function takeNextTask(): ScheduledTask | null {
        if (!queue.length) {
            return null
        }

        let nextIndex = 0

        for (let index = 1; index < queue.length; index += 1) {
            const candidate = queue[index]
            const best = queue[nextIndex]

            if (
                priorityRank[candidate.priority] < priorityRank[best.priority] ||
                (priorityRank[candidate.priority] === priorityRank[best.priority] &&
                    candidate.sequence < best.sequence)
            ) {
                nextIndex = index
            }
        }

        return queue.splice(nextIndex, 1)[0]
    }

    function settleTask(task: ScheduledTask) {
        if (task.key !== null) {
            inFlightByKey.delete(task.key)
        }
    }

    function pump() {
        while (running < maxConcurrent) {
            const task = takeNextTask()

            if (!task) {
                return
            }

            // Skip only when every waiter supplied a signal and all have
            // aborted; a waiter without a signal cannot abort, so the task
            // must still run for it.
            if (
                task.signals.length === task.waiters &&
                task.signals.length > 0 &&
                task.signals.every((signal) => signal.aborted)
            ) {
                settleTask(task)
                task.reject(createAbortError())
                continue
            }

            running += 1
            // Keys can embed full request bodies; truncate before emitting.
            emit('sync-scheduler.task.start', {
                key: task.key ? task.key.slice(0, 80) : 'none',
                priority: task.priority,
                queueWaitMs: Math.max(0, now() - task.enqueuedAt),
                running,
            })

            // Release the slot and the key before resolving the caller, so a
            // follow-up schedule from the caller starts a fresh run instead
            // of joining this completed task.
            void task.run().then(
                (value) => {
                    running -= 1
                    settleTask(task)
                    task.resolve(value)
                    pump()
                },
                (error) => {
                    running -= 1
                    settleTask(task)
                    task.reject(error)
                    pump()
                }
            )
        }
    }

    function schedule<T>(run: () => Promise<T>, options: ScheduleOptions = {}): Promise<T> {
        const key = options.key ?? null

        if (key !== null) {
            const inFlight = inFlightByKey.get(key)

            if (inFlight) {
                if (inFlight.task) {
                    inFlight.task.waiters += 1

                    if (options.signal) {
                        inFlight.task.signals.push(options.signal)
                    }
                }

                emit('sync-scheduler.task.joined', {
                    key: key.slice(0, 80),
                    priority: options.priority ?? 'metadata',
                })
                return inFlight.promise as Promise<T>
            }
        }

        let resolve!: (value: unknown) => void
        let reject!: (error: unknown) => void
        const promise = new Promise<unknown>((promiseResolve, promiseReject) => {
            resolve = promiseResolve
            reject = promiseReject
        })

        const task: ScheduledTask = {
            enqueuedAt: now(),
            key,
            priority: options.priority ?? 'metadata',
            reject,
            resolve,
            run,
            sequence: ++sequence,
            signals: options.signal ? [options.signal] : [],
            waiters: 1,
        }

        queue.push(task)

        if (key !== null) {
            const entry = { promise, task: task as ScheduledTask | null }
            inFlightByKey.set(key, entry)
            const clearTask = () => {
                entry.task = null
            }
            void promise.then(clearTask, clearTask)
        }

        pump()
        return promise as Promise<T>
    }

    return {
        schedule,
        stats() {
            return { pending: queue.length, running }
        },
    }
}
