// Exposed development contracts, derived from the public production prompts.
// These literal witnesses and equivalent programs are not held-out evidence.
import { data, callback, record, returns, throws, callbackPlan, stepReturn, stepThrow, callEvent, settleEvent, errorInput, errorObserved } from "./async-contract-cases.mjs";

export const retrySources = [
  `export async function retry(operation, options={}) {
    const {maxAttempts=3,baseDelayMs=10,sleep}=options;
    if(!Number.isInteger(maxAttempts)||maxAttempts<1||!Number.isFinite(baseDelayMs)||baseDelayMs<0||typeof sleep!=='function')throw new TypeError();
    for(let attempt=1;attempt<=maxAttempts;attempt++) {
      try { return await operation(attempt); }
      catch(error) { if(attempt===maxAttempts)throw error; await sleep(baseDelayMs*2**(attempt-1)); }
    }
  }`,
  `export async function retry(operation, options={}) {
    const attempts=options.maxAttempts===undefined?3:options.maxAttempts, delay=options.baseDelayMs===undefined?10:options.baseDelayMs;
    if(!Number.isInteger(attempts)||attempts<=0||typeof delay!=='number'||!Number.isFinite(delay)||delay<0||typeof options.sleep!=='function')throw new TypeError();
    async function visit(index, wait) {
      try{return await operation(index)}catch(error){if(index>=attempts)throw error;await options.sleep(wait);return visit(index+1,wait*2)}
    }
    return visit(1,delay);
  }`
];
const invoked = (id, call, args, outcome = "return") => [callEvent(id, call, ...args), settleEvent(id, call, outcome)];
export function retryCases() {
  const make = (id, attempts, delay, steps, expected, trace) => {
    const args = [callback("operation"), record({ maxAttempts: data(attempts), baseDelayMs: data(delay), sleep: callback("sleep") })];
    return { id, args, awaitResult: true, observeArgs: true, observeError: true,
      callbacks: [callbackPlan("operation", steps, { repeatLast: true }), callbackPlan("sleep", [stepReturn(undefined)], { repeatLast: true, settleAfterJobs: 4 })],
      errors: [errorInput("first"), errorInput("second"), errorInput("last")],
      expected: { ...expected, argsAfter: args, callbackTrace: trace } };
  };
  return [
    make("first-success", 1, 0, [stepReturn("done")], returns("done"), invoked("operation", 0, [1])),
    make("exponential-success", 4, 3, [stepThrow("first"), stepThrow("second"), stepThrow("last"), stepReturn("done")], returns("done"), [
      ...invoked("operation", 0, [1], "throw"), ...invoked("sleep", 0, [3]), ...invoked("operation", 1, [2], "throw"),
      ...invoked("sleep", 1, [6]), ...invoked("operation", 2, [3], "throw"), ...invoked("sleep", 2, [12]), ...invoked("operation", 3, [4])]),
    make("final-error-no-sleep", 3, 5, [stepThrow("first"), stepThrow("second"), stepThrow("last")], throws("Error", { errorObservation: errorObserved("last") }), [
      ...invoked("operation", 0, [1], "throw"), ...invoked("sleep", 0, [5]), ...invoked("operation", 1, [2], "throw"),
      ...invoked("sleep", 1, [10]), ...invoked("operation", 2, [3], "throw")]),
    ...[0, -1, 1.5, "2", NaN].map((attempts, index) => make(`invalid-attempts-${index}`, attempts, 2, [stepReturn("unreachable")],
      throws("TypeError", { errorObservation: errorObserved(null) }), [])),
    ...[-1, NaN, Infinity, "2"].map((delay, index) => make(`invalid-delay-${index}`, 2, delay, [stepReturn("unreachable")],
      throws("TypeError", { errorObservation: errorObserved(null) }), []))
  ];
}

export const checkpointSources = [
  `export async function resumeWork(items,checkpoint,processItem) {
    if(!checkpoint||!Number.isInteger(checkpoint.nextIndex)||checkpoint.nextIndex<0||checkpoint.nextIndex>items.length||!Array.isArray(checkpoint.results)||checkpoint.results.length!==checkpoint.nextIndex)throw new TypeError();
    const results=[...checkpoint.results];
    for(let index=checkpoint.nextIndex;index<items.length;index++) {
      try{results.push(await processItem(items[index],index))}
      catch(error){error.checkpoint={nextIndex:index,results:[...results]};throw error}
    }
    return {nextIndex:items.length,results};
  }`,
  `export async function resumeWork(items,checkpoint,processItem) {
    if(checkpoint===null||typeof checkpoint!=='object'||!Number.isInteger(checkpoint.nextIndex)||checkpoint.nextIndex<0||checkpoint.nextIndex>items.length||!Array.isArray(checkpoint.results)||checkpoint.results.length!==checkpoint.nextIndex)throw new TypeError();
    let index=checkpoint.nextIndex,results=checkpoint.results.slice();
    while(index<items.length){let value;try{value=await processItem(items[index],index)}catch(error){error.checkpoint={results:results.slice(),nextIndex:index};throw error}results=results.concat([value]);index++}
    return {results,nextIndex:index};
  }`
];
export function checkpointCases() {
  const items = ["a", "b", "c", "d"], initial = { nextIndex: 1, results: ["done:a"] }, partial = { nextIndex: 2, results: ["done:a", "done:b"] };
  const args = [data(items), data(initial), callback("process")];
  const failed = { id: "partial-failure", sequence: "recovery", args, awaitResult: true, observeArgs: true, observeError: true,
    errors: [errorInput("failed", "Error", { code: "E_WORK" })], callbacks: [callbackPlan("process", [stepReturn("done:b"), stepThrow("failed")], { repeatLast: true })],
    expected: throws("Error", { argsAfter: args, callbackTrace: [...invoked("process", 0, ["b", 1]), ...invoked("process", 1, ["c", 2], "throw")],
      errorObservation: errorObserved("failed", { code: "E_WORK", checkpoint: partial }) }) };
  const resumed = { id: "resumed", sequence: "recovery", reset: true, awaitResult: true, observeArgs: true, observeIdentity: true,
    args: [data(items), { type: "error-property", value: "partial-failure", key: "checkpoint" }, callback("process")],
    callbacks: [callbackPlan("process", [stepReturn("done:c"), stepReturn("done:d")], { repeatLast: true })],
    expected: returns({ nextIndex: 4, results: ["done:a", "done:b", "done:c", "done:d"] }, { returnIdentity: [],
      argsAfter: [data(items), data(partial), callback("process")], callbackTrace: [...invoked("process", 0, ["c", 2]), ...invoked("process", 1, ["d", 3])] }) };
  const invalid = [null, { nextIndex: -1, results: [] }, { nextIndex: 5, results: [] }, { nextIndex: 2, results: [] }, { nextIndex: 1.5, results: [] }]
    .map((checkpoint, index) => ({ id: `invalid-${index}`, awaitResult: true, args: [data(items), data(checkpoint), callback("process")],
      callbacks: [callbackPlan("process", [stepReturn("unreachable")], { repeatLast: true })], expected: throws("TypeError", { callbackTrace: [] }) }));
  const complete = { nextIndex: 4, results: ["done:a", "done:b", "done:c", "done:d"] };
  return [failed, resumed, ...invalid, { id: "already-complete", awaitResult: true, observeIdentity: true,
    args: [data(items), data(complete), callback("process")], callbacks: [callbackPlan("process", [stepReturn("unreachable")], { repeatLast: true })],
    expected: returns(complete, { returnIdentity: [], callbackTrace: [] }) }];
}

export const configSources = [
  `export function resolveConfig(cli={},environment={},file={},defaults={}) { const pick=key=>[cli,environment,file,defaults].find(layer=>layer[key]!==undefined)?.[key];return {port:pick('port'),debug:pick('debug'),label:pick('label')}; }`,
  `export function resolveConfig(cli={},environment={},file={},defaults={}) {const result={};for(const key of ['label','debug','port']){result[key]=undefined;for(const layer of [defaults,file,environment,cli])if(layer[key]!==undefined)result[key]=layer[key]}return result;}`
];
export function configCases() {
  return [
    ["cli-falsy", [{ port: 0, debug: false, label: "" }, { port: 4000, debug: true, label: "env" }, { port: 5000 }, { port: 3000 }], { port: 0, debug: false, label: "" }],
    ["file-before-defaults", [{}, {}, { port: 5000, debug: null, label: "file" }, { port: 3000, debug: true, label: "default" }], { port: 5000, debug: null, label: "file" }],
    ["environment-before-file", [{ label: undefined }, { port: null, label: "env" }, { port: 5000, debug: false, label: "file" }, { debug: true }], { port: null, debug: false, label: "env" }],
    ["defaults-only", [{}, {}, {}, { port: 3000, debug: true, label: "default" }], { port: 3000, debug: true, label: "default" }],
    ["all-absent", [], { port: undefined, debug: undefined, label: undefined }]
  ].map(([id, args, output]) => ({ id, args: args.map(data), observeArgs: true, expected: returns(output, { argsAfter: args.map(data) }) }));
}

export const workflowSources = [
  `export const initialWorkflowSession=Object.freeze({currentWorkflow:null,messages:[]});
  export function reduceWorkflowSession(state=initialWorkflowSession,event){
    const text=value=>typeof value==='string'&&value.length>0;
    if(event.type==='workflow/select'){if(!text(event.workflow))throw new TypeError();return {...state,currentWorkflow:event.workflow}}
    if(event.type!=='message/accepted')return state;
    if(!text(event.id)||!text(event.text)||(Object.hasOwn(event,'workflow')&&!text(event.workflow)))throw new TypeError();
    if(state.messages.some(message=>message.id===event.id))return state;
    const workflow=Object.hasOwn(event,'workflow')?event.workflow:state.currentWorkflow;
    if(!text(workflow))throw new TypeError();
    return {...state,currentWorkflow:workflow,messages:[...state.messages,{id:event.id,text:event.text,workflow}]};
  }`
];
export function workflowCases() {
  const state = { currentWorkflow: "alpha", messages: [{ id: "m1", text: "first", workflow: "alpha" }] };
  const cases = [
    ["duplicate-valid", state, { type: "message/accepted", id: "m1", text: "different", workflow: "beta" }, returns(state, { returnIdentity: [0] })],
    ["duplicate-no-active-workflow", { ...state, currentWorkflow: null }, { type: "message/accepted", id: "m1", text: "different" }, returns({ ...state, currentWorkflow: null }, { returnIdentity: [0] })],
    ["switch-preserves-messages", state, { type: "workflow/select", workflow: "beta" }, returns({ ...state, currentWorkflow: "beta" }, { returnIdentity: [] })],
    ["new-override", state, { type: "message/accepted", id: "m2", text: "second", workflow: "beta" }, returns({ currentWorkflow: "beta", messages: [...state.messages, { id: "m2", text: "second", workflow: "beta" }] }, { returnIdentity: [] })],
    ["invalid-duplicate-text", state, { type: "message/accepted", id: "m1", text: "" }, throws()],
    ["invalid-duplicate-override", state, { type: "message/accepted", id: "m1", text: "different", workflow: undefined }, throws()],
    ["invalid-duplicate-null", state, { type: "message/accepted", id: "m1", text: "different", workflow: null }, throws()],
    ["invalid-workflow-select", state, { type: "workflow/select", workflow: "" }, throws()],
    ["no-active-workflow", { ...state, currentWorkflow: null }, { type: "message/accepted", id: "m2", text: "second" }, throws()]
  ];
  return cases.map(([id, input, event, expected]) => ({ id, args: [data(input), data(event)], observeIdentity: true, observeArgs: true,
    expected: { ...expected, argsAfter: [data(input), data(event)] } }));
}
