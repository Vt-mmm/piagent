// Why an approval did not allow the action, in words the agent can act on: a card
// nobody answered in time is not a refusal, and asking again is then the right move.
export function approvalRefusal(decision) {
  const receipt = decision?.receipt;
  if (receipt?.state === 'expired') return Error('managed-operation-expired: the approval card ran out of time with no answer. Nobody refused it and no policy blocked it; the command did not run. Tell the member it is waiting for them, or send the same command again when they are back.');
  if (receipt?.state === 'cancelled') return Error('managed-operation-cancelled: the approval was cancelled because the runtime restarted or stopped the task; nobody refused it and the command did not run.');
  if (receipt?.decision === 'deny') return Error('managed-operation-denied: the member refused this exact command on the approval card; it did not run. Do not send it again unless they say so.');
  return Error('managed-operation-denied: the command was not approved and did not run.');
}
