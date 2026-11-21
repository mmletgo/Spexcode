import { createRoot } from 'react-dom/client'
import { LlmSettings } from 'llm-manager-settings'

async function postSettings(op, fields) {
  const response = await fetch('/llm-manager/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    body: JSON.stringify({ op, ...fields }),
  })
  const payload = await response.json()
  if (response.ok) return payload

  const detail = payload?.detail ?? payload
  const error = new Error(detail?.message ?? detail?.error_code ?? (typeof detail === 'string' ? detail : '设置请求失败'))
  error.name = detail?.name ?? error.name
  error.status_code = response.status
  for (const field of ['provider_id', 'group_ids', 'expected_version', 'actual_version', 'group_id', 'required', 'covered']) {
    if (detail?.[field] !== undefined) error[field] = detail[field]
  }
  throw error
}

const client = {
  async listProviders() { return (await postSettings('list_providers')).providers },
  saveProvider(input) { return postSettings('save_provider', { input }) },
  async deleteProvider(providerId) { await postSettings('delete_provider', { provider_id: providerId }) },
  async listKeys(providerId) { return (await postSettings('list_keys', { provider_id: providerId })).keys },
  saveKey(input) { return postSettings('save_key', { input }) },
  async reorderKeys(providerId, keyIds) {
    return (await postSettings('reorder_keys', { provider_id: providerId, key_ids: keyIds })).keys
  },
  async deleteKey(providerId, keyId) { await postSettings('delete_key', { provider_id: providerId, key_id: keyId }) },
  async listGroups() { return (await postSettings('list_groups')).groups },
  replaceGroup(groupId, members) { return postSettings('replace_group', { group_id: groupId, members }) },
  status() { return postSettings('status') },
  test(request) { return postSettings('test', { request }) },
  queryUsage(query) { return postSettings('query_usage', { query }) },
}

const root = createRoot(document.getElementById('settings'))
postSettings('catalog').then(
  ({ catalog, providerCapabilities }) => {
    root.render(<LlmSettings catalog={catalog} providerCapabilities={providerCapabilities} client={client} />)
  },
  () => root.render(<p className="llm-settings-error" role="alert">无法加载 LLM Manager 设置。请重新加载页面。</p>),
)
