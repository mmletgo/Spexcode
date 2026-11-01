import type { SyncApplication } from './application.js'

/** 旧mock仅验证升级前冻结协议；新默认工作树另由实际Git对象用例验证。 */
export function retainHistoricalFrozenWorkflow(application: SyncApplication): void {
  const freeze = application['freezeNodePlan'].bind(application)
  application['freezeNodePlan'] = async (...args: Parameters<typeof freeze>) => {
    const frozen = await freeze(...args)
    delete frozen.plan.agentWorkflow
    return frozen
  }
  const decorate = application['decorateDecisionPlan'].bind(application)
  application['decorateDecisionPlan'] = (plan, ...args) => {
    decorate(plan, ...args)
    delete plan.agentWorkflow
  }
}
