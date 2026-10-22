import type { PiagentWebUIBoundedFileDiffV1 } from '../../contracts/generated/diff-v1.ts';
import type { PiagentWebUISourceChangeViewV1 } from '../../contracts/generated/source-change-v1.ts';
import { noteUnauthorized } from './bootstrap.ts';
async function read<T>(session: string, fileRef?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/sessions/${encodeURIComponent(session)}/source-review${fileRef ? `/${encodeURIComponent(fileRef)}` : ''}`,
    { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal });
  if (response.status === 401) noteUnauthorized();
  if (!response.ok) throw new Error('source-review-unavailable');
  return response.json() as Promise<T>;
}
export const workspaceReviewSources = (session: string, signal?: AbortSignal) => read<PiagentWebUISourceChangeViewV1>(session, undefined, signal);
export const workspaceReviewDiff = (session: string, fileRef: string, signal?: AbortSignal) => read<PiagentWebUIBoundedFileDiffV1>(session, fileRef, signal);
