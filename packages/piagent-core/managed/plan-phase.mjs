// When a phase ends (owner, 2026-11-14): a checklist of 10 steps that grows
// to 14 after a review, and again after the next, never tells the member when
// the work is done. The checklist now keeps its original steps (gốc) apart
// from the steps added since (phát sinh), each added step with where it came
// from (a review finding, the advisor, a helper, the member); and a phase
// takes at most PHASE_ROUNDS rounds of added steps. After that only a step
// that fixes a blocking finding (its id in source) may join; other new work
// is written as deferred, "để phase sau", and reported at the end.

export const PHASE_ROUNDS = 2;
const key = step => String(step ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
const live = steps => steps.filter(p => p.status !== 'deferred');
const blockingIds = run => new Set((run?.ledger ?? []).filter(i => (i.kind === 'blocking' || i.required) && ['open', 'accepted', 'rejected', 'disputed'].includes(i.status)).map(i => i.id));
const idsIn = source => String(source ?? '').match(/\bo\d+\b/g) ?? [];

// The phase of a checklist about to be written: { base, rounds, added } where
// base is the original steps, added the steps added since ({ step, source,
// round }). `previous` is the checklist written before; a finished one starts
// a new phase. Throws when a third round adds steps that fix no blocking finding.
export function planPhase(run, previous, plan, rounds = PHASE_ROUNDS) {
  const steps = plan.plan, open = previous?.plan?.some(p => p.status === 'pending' || p.status === 'in_progress');
  const before = open && previous?.phase ? previous.phase : open && previous ? { base: previous.plan.map(p => p.step), rounds: 0, added: [], number: 1 } : null;
  const number = before ? before.number ?? 1 : (previous?.phase?.number ?? 0) + 1;
  if (!before) return { number, base: steps.map(p => p.step), rounds: 0, added: [] };
  const known = new Set([...before.base, ...before.added.map(a => a.step)].map(key));
  const fresh = steps.filter(p => !known.has(key(p.step)));
  // A rewording keeps the count: only a checklist with more live steps than before grew.
  const grew = live(steps).length > live(previous.plan).length && live(fresh).length > 0;
  const round = grew ? before.rounds + 1 : before.rounds;
  if (grew && round > rounds) {
    const blocking = blockingIds(run), loose = live(fresh).filter(p => !idsIn(p.source).some(id => blocking.has(id)));
    if (loose.length) throw Error(`managed-plan-phase-full: this phase already took ${rounds} rounds of added steps, so it ends with what is planned. Add these as deferred (để phase sau) instead, and list them for the member at the end: ${loose.map(p => `"${p.step}"`).join(', ')}. Only a step that fixes a blocking finding joins now: name its id in source (for example "review o3").`);
  }
  const added = [...before.added.filter(a => steps.some(p => key(p.step) === key(a.step))),
    ...fresh.map(p => ({ step: p.step, source: p.source || 'main', kind: sourceName(p.source || 'main'), round: p.status === 'deferred' ? 0 : round }))];
  return { number, base: before.base.filter(step => steps.some(p => key(p.step) === key(step))), rounds: round, added };
}

// The counts the member reads: "Phase 1 · gốc 10 · +4 phát sinh · còn 3 · để sau 2".
export function phaseCounts(plan) {
  const steps = plan?.plan ?? [], phase = plan?.phase;
  const addedKeys = new Set((phase?.added ?? []).map(a => key(a.step)));
  const later = steps.filter(p => p.status === 'deferred').length, left = steps.filter(p => p.status === 'pending' || p.status === 'in_progress').length;
  const added = steps.filter(p => p.status !== 'deferred' && addedKeys.has(key(p.step))).length;
  const sources = {};
  for (const a of phase?.added ?? []) if (a.round > 0 && steps.some(p => p.status !== 'deferred' && key(p.step) === key(a.step))) { const s = sourceName(a.source); sources[s] = (sources[s] ?? 0) + 1; }
  return { number: phase?.number ?? 1, base: live(steps).length - added, added, left, later, done: steps.filter(p => p.status === 'completed').length, total: live(steps).length, rounds: phase?.rounds ?? 0, sources };
}
export const sourceName = source => /review|o\d+/i.test(source ?? '') ? 'review' : /advisor/i.test(source ?? '') ? 'advisor' : /member|dev|user/i.test(source ?? '') ? 'dev' : /explore|scout|general|helper|subagent/i.test(source ?? '') ? 'subagent' : 'main';
export const isAdded = (plan, step) => (plan?.phase?.added ?? []).some(a => a.round > 0 && key(a.step) === key(step));

export function phaseHead(plan) {
  const c = phaseCounts(plan);
  const from = Object.entries(c.sources).map(([s, n]) => `${s} ${n}`).join(', ');
  return `Phase ${c.number} · gốc ${c.base}${c.added ? ` · +${c.added} phát sinh${from ? ` (${from})` : ''}` : ''} · xong ${c.done}/${c.total}${c.later ? ` · để phase sau ${c.later}` : ''}${c.rounds >= PHASE_ROUNDS ? ' · hết vòng phát sinh, chỉ nhận lỗi blocking' : c.rounds ? ` · vòng phát sinh ${c.rounds}/${PHASE_ROUNDS}` : ''}`;
}
export const PHASE_PROMPT = ` A phase takes at most ${PHASE_ROUNDS} rounds of added steps: give each step you add after the first checklist a source (review o3, advisor, explore, member). After that, write new non-blocking work as deferred (để phase sau) and list it for the member at the end; only a step that fixes a blocking finding (its id in source) joins.`;
