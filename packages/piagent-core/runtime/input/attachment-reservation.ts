export type AttachmentReservation<T> = {
  prepared: T;
  commit(): void;
  release(): void;
};

// A small transaction primitive for staged attachments. The map is the lock:
// only one dispatch may prepare a ref, and only that dispatch may consume it.
export function reserveAttachments<TRecord extends { attachmentRef: string }, TPrepared>(input: {
  records: TRecord[];
  live: Map<string, TRecord>;
  reservations: Map<string, string>;
  token: string;
  prepared: TPrepared;
  consume(record: TRecord): void;
}): AttachmentReservation<TPrepared> {
  for (const record of input.records) input.reservations.set(record.attachmentRef, input.token);
  let state: "active" | "committed" | "released" = "active";
  return {
    prepared: input.prepared,
    commit: () => {
      if (state === "committed") return;
      if (state !== "active" || input.records.some((record) => input.live.get(record.attachmentRef) !== record
        || input.reservations.get(record.attachmentRef) !== input.token)) throw new Error("attachment-reservation-unavailable");
      state = "committed";
      input.records.forEach(input.consume);
    },
    release: () => {
      if (state !== "active") return;
      state = "released";
      for (const record of input.records) {
        if (input.reservations.get(record.attachmentRef) === input.token) input.reservations.delete(record.attachmentRef);
      }
    }
  };
}
