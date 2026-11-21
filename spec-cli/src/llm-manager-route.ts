export const managedVendors = ['grok', 'claude', 'zcode', 'cursor', 'codex'] as const
export type ManagedVendor = typeof managedVendors[number]
export type ManagedRoute = {
  routeId: string
  vendor: ManagedVendor
  model: string
  kind: 'cli' | 'anthropic-messages'
}

const namespace = '@spex-llm-manager-v1/'
const vendorSet = new Set<string>(managedVendors)

export function readManagedRoute(value: unknown): ManagedRoute {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 4
    || !('routeId' in value) || typeof value.routeId !== 'string' || !/^[0-9a-f]{64}$/u.test(value.routeId)
    || !('vendor' in value) || typeof value.vendor !== 'string' || !vendorSet.has(value.vendor)
    || !('model' in value) || typeof value.model !== 'string' || !value.model || value.model !== value.model.trim() || /[\r\n\0]/u.test(value.model)
    || !('kind' in value) || (value.kind !== 'cli' && (value.kind !== 'anthropic-messages' || value.vendor !== 'claude'))) {
    throw new Error('Invalid LLM Manager route identity')
  }
  return { routeId: value.routeId, vendor: value.vendor as ManagedVendor, model: value.model, kind: value.kind }
}

/** 路线标识只绑定 Manager 归属与公开模型，原生厂商前缀继续控制派发。 */
export function managedModel(route: ManagedRoute): string {
  return `${route.vendor}:${namespace}${Buffer.from(JSON.stringify(readManagedRoute(route))).toString('base64url')}`
}

export function managedRoute(model: string | undefined): ManagedRoute | undefined {
  const separator = model?.indexOf(':') ?? -1
  if (!model || separator < 0 || !model.slice(separator + 1).startsWith(namespace)) return undefined
  const value = model.slice(separator + 1 + namespace.length)
  if (!value || !/^[a-zA-Z0-9_-]+$/u.test(value)) throw new Error('Invalid LLM Manager model binding')
  const route = readManagedRoute(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  if (managedModel(route) !== model) throw new Error('Invalid LLM Manager model binding')
  return route
}

export function nativeModelValue(model: string | undefined, vendor: ManagedVendor): string {
  if (!model?.startsWith(`${vendor}:`)) return ''
  return managedRoute(model)?.model ?? model.slice(vendor.length + 1)
}
