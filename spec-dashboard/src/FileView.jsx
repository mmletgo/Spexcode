import { useMemo, useRef, useState } from 'react'
import SourceView from './SourceView.jsx'
import ProseActions from './ProseActions.jsx'
import { useT } from './i18n/index.jsx'
import { fetchNodeFileSlice, fetchSourceSlice } from './data.js'
import { useBoard } from './workspace.jsx'

// [[file-view]]: a governed source file addressed on its own, for when the reader arrived at the file
// rather than at the node that claims it. It adds nothing to [[source-view]] but an address — which is the
// point: a file opened from the dock and a file opened under its spec must be the same reader.
//
export default function FileView({ param }) {
  const t = useT()
  const { targetTree = null } = useBoard()
  const sourceHostRef = useRef(null)
  const [selection, setSelection] = useState(null)
  const parts = param?.startsWith('.spec/') ? param.slice('.spec/'.length).split('/') : []
  const attachment = parts.length >= 2 ? { nodeId: parts[0], name: parts.slice(1).join('/') } : null
  const nodeId = attachment?.nodeId
  const name = attachment?.name
  const read = useMemo(() => nodeId ? (offset) => fetchNodeFileSlice(nodeId, name, offset, undefined, targetTree) : (offset) => fetchSourceSlice(param, offset, undefined, targetTree),
    [nodeId, name, param, targetTree])
  if (!param) return <div className="doc-empty">{t('fileView.none')}</div>
  // Attachment chips use the same #/file address family with a logical `.spec/<node>/<name>` path.
  // `.spec/**` is outside /api/source's governed-file policy, so route those reads through the node-owned
  // endpoint while keeping one FileView and one tab identity for both kinds of file document.
  return (
    <div className="fileview" ref={sourceHostRef}>
      {targetTree && <p className="read-tree" data-read-tree={targetTree} title={targetTree}>{t('specView.deliveryTree', { name: targetTree.split('/').filter(Boolean).at(-1) })}</p>}
      <SourceView key={`${targetTree || ''}/${param}`} path={param} read={read} onSelection={setSelection} />
      {!targetTree && <ProseActions hostRef={sourceHostRef} codeSelection={selection} onCodeSelectionClear={() => setSelection(null)} />}
    </div>
  )
}
