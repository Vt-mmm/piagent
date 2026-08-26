Fix `deduplicateEvents(events)` in `src/data/dedup.js`.

Return one event per `id`. The output order must follow the first appearance of
each id, while the retained value for that id must be the event with the
greatest numeric `sequence`. If sequences tie, retain the later occurrence.
Do not mutate the input. Keep the exported API and verify the project.
