import { useEffect, useState } from 'react'
import { loadPublicSpecContent, specUrl } from './data.js'
import { PUBLIC_GRAPH_ONLY } from './public-mode.js'
import { useBoard } from './workspace.jsx'

// Body content is shared by the full document, the node popup, and the selection layer so all three
// surfaces address the same fetched version.
const contentCache = new Map()

// Which source a body comes from is a property of the BUILD, not of the call site: a published tree has one
// static document per node and no backend at all. Defaulting the flag here means every surface that reads a
// body — the document, the popup, the selection layer — is right in both builds without repeating the choice.
export function useSpecContent(id, version, { embedded = false, publicGraph = PUBLIC_GRAPH_ONLY } = {}) {
  const { contentRevision = 0 } = useBoard()
  const revision = publicGraph ? 0 : contentRevision
  const key = `${publicGraph ? 'public:' : ''}${id}@${version ?? ''}`
  const [held, setHeld] = useState(() => ({ key, content: contentCache.get(key)?.content ?? null }))
  useEffect(() => {
    if (embedded || !id) return undefined
    const hit = contentCache.get(key)
    if (hit?.revision === revision) { setHeld({ key, content: hit.content }); return }
    let on = true
    const request = publicGraph
      ? loadPublicSpecContent(id)
      : fetch(specUrl(id, 'content')).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    request
      .then((d) => { if (on) { contentCache.set(key, { revision, content: d }); setHeld({ key, content: d }) } })
      .catch((error) => { if (on) setHeld({ key, content: { error: String(error), body: '', parts: null } }) })
    return () => { on = false }
  }, [embedded, id, version, key, publicGraph, revision])
  return held.key === key ? held.content : null
}
