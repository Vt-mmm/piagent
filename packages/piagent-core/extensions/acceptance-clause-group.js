import crypto from 'node:crypto';
import { acceptanceCriterionBindingValid } from './acceptance-behavior-proof.js';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');

// Derived children are projections of one already bound parent, never new
// operator criteria. Offsets and the unchanged full context preserve every
// clause and its qualifiers across packing, resume and receipt refresh.
export function boundAcceptanceClauseGroup(task, receipt, criterion, index) {
  if (!Array.isArray(receipt?.criteria) || !criterion || !Number.isInteger(index) || index < 0 || !acceptanceCriterionBindingValid(task, receipt, criterion, index)) return null;
  const text = task.acceptanceCriteria[index];
  if (text.length > 600 || !text.includes('\n') || text.includes('\r')
    || typeof task.operatorRequest !== 'string'
    || task.operatorRequestDigest !== `operator-request-v1:${hash(task.operatorRequest)}`) return null;
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  if (!normalize(task.operatorRequest).includes(normalize(text))) return null;
  const lines = text.split('\n');
  if (lines.length < 2 || lines.length > 32 || lines.some(line => !line.trim() || line !== line.trim()
    || (line.match(/`/g)?.length ?? 0) % 2 !== 0)) return null;
  let offset = 0;
  const children = lines.map((line, ordinal) => {
    const child = {id: `clause-${hash(`${criterion.id}\0${ordinal}\0${line}`).slice(0, 24)}`,
      text: line, hash: hash(line), ordinal, start: offset, end: offset + line.length};
    offset = child.end + 1; return child;
  });
  return {parentId: criterion.id, parentHash: criterion.hash, requestDigest: task.operatorRequestDigest,
    context: task.operatorRequest, text, children};
}

export function allClauseEvidence(group, childEvidence, workingTreeDigest) {
  if (!group || !Array.isArray(group.children) || group.children.length < 2 || !Array.isArray(childEvidence)
    || childEvidence.length !== group.children.length || !workingTreeDigest) return undefined;
  const accepted = group.children.map((child, index) => {
    const item = childEvidence[index];
    return item?.id === child.id && item?.hash === child.hash && item.evidence?.workingTreeDigest === workingTreeDigest
      && item.evidence.exitCode === 0 && typeof item.evidence.command === 'string' && item.evidence.command.trim()
      ? item.evidence : null;
  });
  if (accepted.some(item => item === null)) return undefined;
  const binding = hash(JSON.stringify({request: group.requestDigest, parent: group.parentHash,
    children: group.children.map((child, index) => ({hash: child.hash, start: child.start, end: child.end, evidence: accepted[index]}))}));
  return {kind: 'all-clause-proof', summary: `All ${accepted.length} lossless clauses have current evidence; binding sha256:${binding}.`,
    command: accepted[0].command, exitCode: 0, workingTreeDigest,
    paths: [...new Set(accepted.flatMap(item => item.paths ?? []))]};
}
