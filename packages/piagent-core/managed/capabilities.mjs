import { nativeManagedModel, piProvider } from './native-catalog.mjs';
export const THINKING = ['off','minimal','low','medium','high','xhigh','max'];
export function nativeThinkingLevels(model) {
  if (!model?.reasoning) return ['off'];
  const mapping=model.thinkingLevelMap??{};
  return THINKING.filter(level=>mapping[level]!==null && (!['xhigh','max'].includes(level)||mapping[level]!==undefined));
}
// A selected level must work for the current main route and at least one
// permitted candidate for every enabled helper. Studio rechecks availability
// and policy on run creation; this is capability UI, not an admission promise.
export function managedThinkingLevels(manifest, runtime, main) {
  // A role whose level the Harness fixes does not narrow the member's choice.
  const roles=Object.entries(manifest.harness.configuration).filter(([name,r])=>r&&Array.isArray(r.model_ids)&&(name==='main'||r.effort==null)).map(([,r])=>r);
  return nativeThinkingLevels(main).filter(level=>(!Array.isArray(manifest.thinking_levels)||manifest.thinking_levels.includes(level)) && roles.every(role=>role.model_ids.some(id=>{
    const item=manifest.models.find(m=>m.id===id);
    if(!item)return false;
    const native=nativeManagedModel(runtime,piProvider(item.owned_by),item.provider_model_id);
    return native && nativeThinkingLevels(native).includes(level);
  })));
}

// Pi's rule for a level a model lacks: the next deeper one it has, else the
// next shallower one. Without a list every level stands.
export function nearestLevel(level, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0 || allowed.includes(level)) return level;
  const order = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], at = Math.max(0, order.indexOf(level));
  return order.slice(at).find(l => allowed.includes(l)) ?? order.slice(0, at).reverse().find(l => allowed.includes(l)) ?? allowed[0];
}
