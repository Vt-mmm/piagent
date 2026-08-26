export function billingBucket(event, period) {
  if (event.occurredAt < period.startsAt || event.occurredAt > period.endsAt) return "outside";
  return event.receivedAt > period.endsAt ? "late" : "current";
}
