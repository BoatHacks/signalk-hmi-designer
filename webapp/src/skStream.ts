import { useEffect, useRef, useState } from 'react'
import {
  fetchNotifications,
  resolveBindPath,
  type NotificationRow
} from './api'

export type SkValue = number | string | boolean | null

/** Drill into a delta's raw value using the extra dotted segments a
 *  manually-extended bind reaches past its real SK path (see
 *  `resolveBindPath`). Returns null for anything past the last object
 *  layer or for a non-scalar leaf — matching kinds are what
 *  `pushAllValues` already handles for pushed data. */
function getNestedField(value: unknown, fieldPath: string[]): SkValue {
  let cur: unknown = value
  for (const key of fieldPath) {
    if (cur === null || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[key]
  }
  if (
    typeof cur === 'number' ||
    typeof cur === 'string' ||
    typeof cur === 'boolean'
  ) {
    return cur
  }
  return null
}

interface DeltaMessage {
  context?: string
  updates?: Array<{
    values?: Array<{ path: string; value: SkValue }>
  }>
}

/**
 * Minimal SignalK delta-stream client.
 *
 * Opens a WS to /signalk/v1/stream on the same origin, subscribes to
 * `paths`, and exposes a Map<bind, value> that updates as deltas
 * arrive. The subscription is re-issued whenever `paths` changes so
 * widgets that get newly-bound paths start receiving data on next
 * delta (without reconnecting).
 *
 * `paths` are widget binds, not necessarily real SK paths verbatim —
 * a bind may manually reach past a real SK leaf into a JSON object
 * field (`bar.foo.thing.value.name`). `knownSkPaths` (the live
 * self-paths list) is used to split each bind into the real SK path
 * to subscribe to plus the extra dotted segments to resolve
 * client-side once a delta for the parent path arrives — see
 * `resolveBindPath`. The returned map is still keyed by the original
 * bind string, so callers (zone matching, the wasm subject push)
 * don't need to know a bind was extended.
 *
 * Re-renders are coalesced via setState's microtask batching, which is
 * fine at the typical SK delta rate. If we ever sustain >100 deltas/s
 * we'd need to throttle — but that's not a today problem.
 */
export function useSkValues(
  paths: string[],
  knownSkPaths: readonly string[] = []
): Map<string, SkValue> {
  const [values, setValues] = useState<Map<string, SkValue>>(() => new Map())
  const wsRef = useRef<WebSocket | null>(null)

  const resolved = paths.map((bind) => ({
    bind,
    ...resolveBindPath(bind, knownSkPaths)
  }))
  // Stable serialization so the effect only re-runs when the actual
  // set of subscribed SK paths, or the bind->field mapping, changes —
  // not on every array/knownSkPaths reference change.
  const skPathsKey = [...new Set(resolved.map((r) => r.skPath))]
    .sort()
    .join('|')
  const bindMapKey = resolved
    .map((r) => `${r.bind}=${r.skPath}:${r.fieldPath.join('.')}`)
    .sort()
    .join('\n')

  // The message handler needs the current bind->field mapping but
  // shouldn't itself force a reconnect when only fieldPaths change
  // without the subscribed SK path set changing — a ref keeps it
  // fresh without adding to the effect's deps.
  const resolvedRef = useRef(resolved)
  resolvedRef.current = resolved

  useEffect(() => {
    if (!skPathsKey) return undefined
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${
      location.host
    }/signalk/v1/stream?subscribe=none`
    const ws = new WebSocket(url)
    wsRef.current = ws
    let closed = false

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          context: 'vessels.self',
          subscribe: skPathsKey
            .split('|')
            .filter(Boolean)
            .map((p) => ({ path: p, period: 1000 }))
        })
      )
    })

    ws.addEventListener('message', (ev) => {
      let msg: DeltaMessage
      try {
        msg = JSON.parse(ev.data as string) as DeltaMessage
      } catch {
        return
      }
      if (!msg.updates) return
      // Build a single batched update.
      setValues((prev) => {
        let next: Map<string, SkValue> | null = null
        for (const u of msg.updates ?? []) {
          for (const v of u.values ?? []) {
            for (const r of resolvedRef.current) {
              if (r.skPath !== v.path) continue
              if (next === null) next = new Map(prev)
              next.set(
                r.bind,
                r.fieldPath.length === 0
                  ? v.value
                  : getNestedField(v.value, r.fieldPath)
              )
            }
          }
        }
        return next ?? prev
      })
    })

    ws.addEventListener('close', () => {
      if (closed) return
      // Caller doesn't currently retry — a refresh covers it. Worth
      // adding exponential backoff if reliability becomes an issue.
    })

    return () => {
      closed = true
      ws.close()
    }
  }, [skPathsKey, bindMapKey])

  return values
}

/** Poll the SK notifications.* tree and expose a flat array of row
 *  objects. The list widget binds to the synthetic `"notifications"`
 *  path; firmware maintains the same registry from WS deltas, so the
 *  designer poll only has to be fast enough that the operator sees
 *  the canvas update before they finish a layout edit — 2 s is fine.
 *
 *  `includeCleared` widens the fetch to also emit rows in cleared
 *  states (normal/nominal). Each list widget then filters its own
 *  slice — but the fetch must run in the wider mode if any widget
 *  on the canvas wants the cleared rows. */
export function useNotifications(
  enabled: boolean,
  includeCleared: boolean = false
): NotificationRow[] {
  const [rows, setRows] = useState<NotificationRow[]>([])
  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    async function tick(): Promise<void> {
      const next = await fetchNotifications({ includeCleared })
      if (!cancelled) setRows(next)
    }
    void tick()
    const id = window.setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [enabled, includeCleared])
  return rows
}
