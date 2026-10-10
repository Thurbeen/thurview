# relay: fan-out delivery with a dead-letter queue

**Summary**

- Split delivery into a **fan-out router** that writes one row per subscriber, so one slow endpoint stops holding back the others.
- Add a **dead-letter queue** for events that exhaust their retries. Today [they are dropped silently](anchor:dropped).
- Keep the receive path exactly as it is: [verify, store once, answer 202](anchor:receive).

**Why.** Every subscriber of an event shares one outbox row and [one attempt counter](anchor:tick). A single failing endpoint makes the relay re-post the event to every healthy subscriber on each retry, and after eight attempts the event is gone with no trace.

## How a delivery works today

The relay is three steps over one table:

1. **Receive.** The HTTP handler [checks the sender's HMAC](anchor:verify) and [inserts one outbox row](anchor:enqueue).
2. **Lease.** A worker [leases the oldest due row](anchor:lease) for thirty seconds, so a second worker cannot take it too.
3. **Deliver.** The worker [posts to every subscriber at once](anchor:tick) and settles the row: delete on success, [reschedule with backoff](anchor:backoff) otherwise.

| Part | Owns | Today |
| ---- | ---- | ----- |
| Receiver | signature check, 202 | unchanged |
| Outbox | one row per event | becomes one row per subscriber |
| Worker | post, retry, drop | stops dropping |

## What to build

### One event, end to end

```sequence
label: One event, end to end
messages:
  - { from: sender, to: receiver, label: POST /events with an HMAC signature, anchor: receive }
  - { from: receiver, to: outbox, label: store the event once, anchor: enqueue }
  - { from: outbox, to: router, label: hand the new event to the router, anchor: enqueue }
  - { from: router, to: outbox, label: write one delivery row per subscriber, anchor: enqueue }
  - { from: worker, to: outbox, label: lease the oldest due delivery, anchor: lease }
  - { from: worker, to: subscriber, label: POST the body to one endpoint, anchor: tick }
  - { from: worker, to: deadletter, label: park it after the last attempt, anchor: dropped }
```

The router is the only new writer. The worker keeps its loop but leases a **delivery** instead of an event, so its attempt counter belongs to one endpoint.

### Retry or park

```flow
label: Retry or park
steps:
  - { id: post, label: post one delivery, anchor: tick, next: ok }
  - { id: ok, label: answered 2xx?, actor: worker, when: [{ case: "yes", to: settle }, { case: "no", to: budget }] }
  - { id: budget, label: attempts left?, anchor: backoff, when: [{ case: "yes", to: retry }, { case: "no", to: park }] }
  - { id: retry, label: reschedule with doubled delay, anchor: backoff }
  - { id: park, label: move to the dead-letter queue, anchor: dropped }
  - { id: settle, label: delete the delivery row, anchor: tick }
```

## Failure handling

- **A slow subscriber** now delays only its own deliveries. The [lease window](anchor:lease) stays thirty seconds.
- **A dead endpoint** fills the dead-letter queue instead of being retried forever. The operator replays it from the admin view.
- **The relay restarting** loses nothing, because every row is in the [outbox table](anchor:schema) before the 202 goes out.

## Migration

1. Add the `deliveries` and `dead_letter` tables beside `outbox`; the [attempt budget](anchor:config) keeps its meaning, per delivery now.
2. Ship the router behind a flag; the worker reads both tables while it is on.
3. Drain `outbox`, then drop the old path.

## Open questions

- Should a replay from the dead-letter queue reset the attempt counter, or keep it for the record?
- Is per-subscriber ordering a promise, or best effort as today?
