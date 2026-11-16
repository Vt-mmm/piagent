// A harness review whose patch changed while it ran is stale, and the harness
// reviewed again, with no limit. While the harness reviews, the main agent is
// waiting, so a change then is someone else's: another conversation in the
// same folder, a watcher, a generator (owner, 2026-11-16: four stale reviews
// in a row, about 900k tokens, while a guide session regenerated
// screenshots). A stale review is run again once; stale a second time, the
// harness stops reviewing, names the files that changed during it, and the
// turn reports the patch as not reviewed for that reason.
export const STALE_REVIEWS = 2;

const changedBetween = (before, after) => before && after ? [...new Set([...before.keys(), ...after.keys()])].filter(name => before.get(name) !== after.get(name)).sort() : [];

// True when the harness stops reviewing (the review gate breaks).
export async function reviewOvertaken(managed, run, filesBefore, note) {
  if (!managed.review?.stale) return false;
  run.staleReviews = (run.staleReviews ?? 0) + 1;
  if (run.staleReviews < STALE_REVIEWS) return false;
  const files = changedBetween(filesBefore, await managed.changedFiles?.());
  run.reviewOvertaken = files.length ? files.slice(0, 50) : ['(the files could not be listed)'];
  run.reviewSettled = true;
  await note(`Harness: the review went stale ${run.staleReviews} times in a row: files changed while it ran, and the main agent was waiting, so something else changed them (another conversation in this folder, a watcher or a generator). The harness stops reviewing this turn.\nChanged during the review: ${run.reviewOvertaken.slice(0, 10).join(', ')}${files.length > 10 ? ` and ${files.length - 10} more` : ''}`,
    { phase: 'review-overtaken', files: run.reviewOvertaken.slice(0, 20) });
  return true;
}
