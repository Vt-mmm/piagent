export const initialWorkflowSession = Object.freeze({ currentWorkflow: null, messages: [] });

export function reduceWorkflowSession(state = initialWorkflowSession, event) {
  if (event.type === "workflow/select") return { currentWorkflow: event.workflow, messages: [] };
  if (event.type === "message/accepted") {
    return { ...state, messages: [...state.messages, { id: event.id, text: event.text }] };
  }
  return state;
}
