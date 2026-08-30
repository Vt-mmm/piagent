// Two exposed equivalent implementations per API, plus intentionally faulty
// variants. These strings execute only inside the isolated contract worker.
import { retrySources, checkpointSources, configSources, workflowSources } from "./async-production-cases.mjs";
export const familyPrograms = {
  retry: [retrySources[0].replace("baseDelayMs=10,sleep", "baseDelayMs=10,sleep=delay=>new Promise(resolve=>setTimeout(resolve,delay))"),
    retrySources[1].replace("const attempts=", "const sleep=options.sleep===undefined?(delay=>new Promise(resolve=>setTimeout(resolve,delay))):options.sleep;const attempts=")
      .replace("typeof options.sleep", "typeof sleep").replace("await options.sleep(wait)", "await sleep(wait)")],
  checkpoint: checkpointSources,
  config: configSources,
  workflow: [workflowSources[0], `export const initialWorkflowSession={currentWorkflow:null,messages:[]};
    export function reduceWorkflowSession(state=initialWorkflowSession,event){
      function required(value){if(typeof value!=='string'||value.length===0)throw new TypeError()}
      switch(event.type){
        case 'workflow/select':required(event.workflow);return Object.assign({},state,{currentWorkflow:event.workflow});
        case 'message/accepted':{
          required(event.id);required(event.text);const override=Object.prototype.hasOwnProperty.call(event,'workflow');if(override)required(event.workflow);
          if(state.messages.findIndex(message=>message.id===event.id)!==-1)return state;
          const workflow=override?event.workflow:state.currentWorkflow;required(workflow);
          return Object.assign({},state,{currentWorkflow:workflow,messages:state.messages.concat([{id:event.id,text:event.text,workflow}])});
        }
        default:return state;
      }
    }`],
  search: [
    `export const initialSearchState=Object.freeze({requestId:null,loading:false,results:[]});
    export function searchReducer(state=initialSearchState,action){
      if(action.type==='search/start')return {...state,requestId:action.requestId,loading:true};
      if(action.type!=='search/success'&&action.type!=='search/failure')return state;
      if(action.requestId!==state.requestId)return state;
      if(action.type==='search/success')return {...state,loading:false,results:action.results};
      return {...state,loading:false};
    }`,
    `export const initialSearchState={requestId:null,loading:false,results:[]};
    export function searchReducer(state=initialSearchState,action){switch(action.type){
      case 'search/start':return Object.assign({},state,{requestId:action.requestId,loading:true});
      case 'search/success':return action.requestId===state.requestId?Object.assign({},state,{results:[...action.results],loading:false}):state;
      case 'search/failure':return action.requestId===state.requestId?Object.assign({},state,{loading:false}):state;
      default:return state;
    }}`
  ],
  request: [
    `export const initialRequestState=Object.freeze({activeRequestId:null,connectionEpoch:0,loading:false,results:[],error:null});
    export function requestLifecycleReducer(state=initialRequestState,action){
      if(action.type==='request/start')return {...state,activeRequestId:action.requestId,connectionEpoch:action.epoch,loading:true,error:null};
      if(action.type==='connection/reconnect')return action.epoch>state.connectionEpoch?{...state,activeRequestId:null,connectionEpoch:action.epoch,loading:false,error:null}:state;
      if(action.type!=='request/success'&&action.type!=='request/failure')return state;
      if(state.activeRequestId===null||action.requestId!==state.activeRequestId||action.epoch!==state.connectionEpoch)return state;
      return {...state,activeRequestId:null,loading:false,...(action.type==='request/success'?{results:[...action.results],error:null}:{error:action.error})};
    }`,
    `export const initialRequestState={activeRequestId:null,connectionEpoch:0,loading:false,results:[],error:null};
    export function requestLifecycleReducer(state=initialRequestState,action){
      const update=patch=>Object.assign({},state,patch);
      switch(action.type){
        case 'request/start':return update({activeRequestId:action.requestId,connectionEpoch:action.epoch,loading:true,error:null});
        case 'connection/reconnect':if(action.epoch<=state.connectionEpoch)return state;return update({activeRequestId:null,connectionEpoch:action.epoch,loading:false,error:null});
        case 'request/success':case 'request/failure':{
          if(!(state.activeRequestId!==null&&state.activeRequestId===action.requestId&&state.connectionEpoch===action.epoch))return state;
          const patch={activeRequestId:null,loading:false};if(action.type==='request/success'){patch.results=action.results.slice();patch.error=null}else patch.error=action.error;return update(patch);
        }
        default:return state;
      }
    }`
  ]
};

const rows = [
  ["retry", "bounded-retry-injected-sleep", 1, "retry", "reliability/retry.js"],
  ["checkpoint", "partial-checkpoint-resume", 1, "resumeWork", "reliability/checkpoint.js"],
  ["config", "defined-config-precedence", 2, "resolveConfig", "platform/config.js"],
  ["workflow", "workflow-message-reducer", 1, "reduceWorkflowSession", "platform/workflow-session.js"],
  ["search", "stale-search-reducer", 1, "searchReducer", "frontend/search-state.js"],
  ["request", "epoch-request-lifecycle", 1, "requestLifecycleReducer", "frontend/request-lifecycle.js"]
];
export const familyRows = rows.map(([key, id, version, call, fixture]) => ({ key, id, version, call, fixture,
  parameters: { call, ...(key === "config" ? { numericKey: "port", booleanKey: "debug", textKey: "label" } : {}) }, sources: familyPrograms[key] }));
const mutation = (key, label, before, after) => {
  const original = familyPrograms[key][0], source = original.replace(before, after);
  if (original === source) throw new Error(`Unapplied mutant: ${label}`);
  return { key, label, source };
};
export function familyMutants() {
  return [
    mutation("retry", "missing-sleep-await", "await sleep(", "sleep("),
    mutation("retry", "linear-backoff", "2**(attempt-1)", "attempt"),
    mutation("retry", "wrapping-final-error", "throw error;", "throw new Error(error.message);"),
    mutation("retry", "wrong-default-count", "maxAttempts=3", "maxAttempts=2"),
    mutation("checkpoint", "first-failure-alias", "error.checkpoint={nextIndex:index,results:[...results]}", "error.checkpoint=index===checkpoint.nextIndex?checkpoint:{nextIndex:index,results:[...results]}"),
    mutation("checkpoint", "replay-completed", "let index=checkpoint.nextIndex", "let index=0"),
    mutation("checkpoint", "lost-progress", "results:[...results]", "results:[...checkpoint.results]"),
    mutation("checkpoint", "input-mutation", "const results=[...checkpoint.results]", "const results=checkpoint.results"),
    mutation("config", "three-layer-precedence", "[cli,environment,file,defaults]", "[cli,environment,defaults]"),
    mutation("config", "null-is-absent", "layer[key]!==undefined", "layer[key]!=null"),
    mutation("workflow", "duplicate-copy", "some(message=>message.id===event.id))return state", "some(message=>message.id===event.id))return {...state}"),
    mutation("workflow", "duplicate-before-validation", "if(!text(event.id)", "if(state.messages.some(message=>message.id===event.id))return state;if(!text(event.id)"),
    mutation("workflow", "switch-clears-messages", "currentWorkflow:event.workflow}", "currentWorkflow:event.workflow,messages:[]}"),
    mutation("search", "stale-copy", "if(action.requestId!==state.requestId)return state", "if(action.requestId!==state.requestId)return {...state}"),
    mutation("search", "failure-loses-results", "return {...state,loading:false};", "return {...state,loading:false,results:[]};"),
    mutation("request", "result-array-alias", "results:[...action.results]", "results:action.results"),
    mutation("request", "ignored-epoch", "||action.epoch!==state.connectionEpoch", ""),
    mutation("request", "reconnect-keeps-active", "activeRequestId:null,connectionEpoch:action.epoch", "activeRequestId:state.activeRequestId,connectionEpoch:action.epoch")
  ];
}
