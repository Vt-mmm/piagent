// The report a maintainer reads after a night's soak: would members have
// stayed, and what made them push.
const cell = v => String(v ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

export function markdownReport(report) {
  const lines = [`# Long-task soak ${report.startedAt}`, ''];
  if (report.mode === 'self-check') {
    lines.push('| Scenario | Oracle | Baseline | Reference |', '|---|---|---|---|');
    for (const r of report.results) lines.push(`| ${r.scenario} | ${r.skipped ? `skipped (${r.skipped.join(', ')})` : r.ok ? 'ok' : 'BROKEN'} | ${cell(r.baseline?.map(c => `${c.name}:${c.pass ? 'pass' : 'fail'}`).join(' '))} | ${cell(r.reference?.map(c => `${c.name}:${c.pass ? 'pass' : 'fail'}`).join(' ') ?? r.error)} |`);
    return lines.join('\n') + '\n';
  }
  const runs = report.results.filter(r => !r.skipped);
  const count = v => runs.filter(r => r.verdict === v).length;
  lines.push(`Runs: ${runs.length} · smooth ${count('smooth')} · recovered ${count('recovered')} · abandoned ${count('abandoned')} · harness errors ${count('harness_error')}`, '');
  const defects = {};
  for (const r of runs) for (const d of r.defects ?? []) defects[d.defect] = (defects[d.defect] ?? 0) + 1;
  if (Object.keys(defects).length) {
    lines.push('## What made members push', '', '| Defect | Runs |', '|---|---|');
    for (const [d, n] of Object.entries(defects).sort((a, b) => b[1] - a[1])) lines.push(`| ${d} | ${n} |`);
    lines.push('');
  }
  lines.push('## Runs', '', '| Scenario | Surface | Verdict | Phases | Min | Turns | Nudges | Stalls | Crashes | Questions | Tools (err) | Retries | Compactions | Stops/restarts | Defects |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of runs) {
    const s = r.stats ?? {};
    lines.push(`| ${r.scenario} | ${r.surface} | **${r.verdict}** | ${r.phases ?? ''} | ${r.minutes ?? ''} | ${s.turns ?? ''} | ${s.nudges ?? ''} | ${s.stalls ?? ''} | ${s.crashes ?? ''} | ${s.questions ?? ''} | ${s.toolCalls ?? ''} (${s.toolErrors ?? ''}) | ${s.providerRetries ?? ''} | ${s.compactions ?? ''} | ${s.memberStops ?? ''}/${s.restarts ?? ''} | ${cell((r.defects ?? []).map(d => d.defect).join(', ') || r.error?.split('\n')[0])} |`);
  }
  for (const r of runs.filter(r => r.verdict !== 'smooth')) {
    lines.push('', `### ${r.scenario} on ${r.surface}: ${r.verdict}`, '', `Run folder: \`${r.runDir}\``, '');
    for (const t of r.turns ?? []) lines.push(`- turn ${t.n} [${t.phase ?? 'main'}] (${t.minutes} min): ${t.kind}${t.defect ? ` — ${t.defect}` : ''}${t.oracle ? ` · checks ${t.oracle.pass ? 'pass' : `fail: ${t.oracle.failed.join(', ')}`}` : ''}`);
    if (r.lastText) lines.push('', '> ' + cell(r.lastText.slice(-600)));
    if (r.error) lines.push('', '```', r.error.slice(0, 1200), '```');
  }
  for (const r of report.results.filter(r => r.skipped)) lines.push('', `Skipped ${r.scenario}: missing ${r.skipped.join(', ')}`);
  return lines.join('\n') + '\n';
}
