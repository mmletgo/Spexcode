import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { fromForge, issueHierarchy, issueRefs, mergedIssues, type Issue } from './issues.js'
import { closeLocalIssue, loadLocalIssues, loadOne, openIssue, relateLocalIssue, reparentLocalIssue } from './localIssues.js'

// the stored shape a store read hands the merged read: every derived field at its empty value.
const stored = (id: string, at: number, over: Partial<Issue> = {}): Issue => ({
  id, store: 'local', concern: id, by: 'test', status: 'open', nodes: [], created: `2026-09-13T00:00:${String(at).padStart(2, '0')}Z`, closedAt: null,
  body: '', replies: [], evidence: [], labels: [],
  parent: null, children: [], descendants: [], childCounts: { open: 0, closed: 0 },
  relations: [], blockedBy: [], relatedBy: [], duplicatedBy: [], duplicateOf: null,
  ...over,
})
const byId = (issues: Issue[]) => new Map(issues.map((i) => [i.id, i]))

function withDisposableStore(fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'spex-issue-tree-'))
  const previous = process.env.SPEXCODE_ISSUES_DIR
  process.env.SPEXCODE_ISSUES_DIR = dir
  try { fn() } finally {
    if (previous === undefined) delete process.env.SPEXCODE_ISSUES_DIR
    else process.env.SPEXCODE_ISSUES_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the issue tree is rebuilt at read: a child nests under a present parent, open or closed, else it is a root', () => {
  const out = byId(issueHierarchy([
    stored('epic', 1),
    stored('task', 2, { parent: 'epic' }),
    stored('step', 3, { parent: 'task' }),
    stored('done-task', 4, { parent: 'epic', status: 'landed' }),
    stored('orphan', 5, { parent: 'no-such-issue' }),
    stored('shipped', 6, { status: 'landed' }),
    stored('under-shipped', 7, { parent: 'shipped' }),
  ]))
  assert.equal(out.get('task')?.parent, 'epic')
  assert.equal(out.get('step')?.parent, 'task')
  assert.deepEqual(out.get('epic')?.children, ['task', 'done-task'], 'direct children, oldest first; a closed child is still a child')
  assert.deepEqual(out.get('epic')?.childCounts, { open: 1, closed: 1 })
  assert.deepEqual(out.get('task')?.children, ['step'])
  assert.equal(out.get('orphan')?.parent, null, 'a parent absent from the set promotes the child')
  assert.equal(out.get('under-shipped')?.parent, 'shipped', 'a closed parent keeps its child: a closed tree keeps its shape')
  assert.deepEqual(out.get('shipped')?.children, ['under-shipped'])
  assert.deepEqual(out.get('epic')?.descendants, ['task', 'step', 'done-task'], 'every issue below, depth-first, oldest sibling first')
  assert.deepEqual(out.get('step')?.descendants, [])
})

test('refs give the detail read the compact face of every issue its hierarchy names, and nothing else', () => {
  const merged = issueHierarchy([
    stored('epic', 1),
    stored('task', 2, { parent: 'epic', relations: [{ type: 'blocks', id: 'other' }] }),
    stored('other', 3),
    stored('dup', 4, { status: 'landed', relations: [{ type: 'duplicate', id: 'task' }] }),
    stored('unrelated', 5),
  ])
  const task = byId(merged).get('task')!
  const refs = issueRefs(task, merged)
  assert.deepEqual(Object.keys(refs).sort(), ['dup', 'epic', 'other'])
  assert.deepEqual(refs.epic, { id: 'epic', store: 'local', concern: 'epic', status: 'open', by: 'test', created: '2026-09-13T00:00:01Z', closedAt: null, childCounts: { open: 1, closed: 0 }, descendants: ['task'] })
  assert.equal(refs.dup.status, 'landed')
})

test('a parent cycle promotes its members to roots and keeps their descendants attached', () => {
  const out = byId(issueHierarchy([
    stored('x', 1, { parent: 'y' }),
    stored('y', 2, { parent: 'x' }),
    stored('z', 3, { parent: 'x' }),
    stored('self', 4, { parent: 'self' }),
  ]))
  assert.equal(out.get('x')?.parent, null)
  assert.equal(out.get('y')?.parent, null)
  assert.equal(out.get('self')?.parent, null)
  assert.equal(out.get('z')?.parent, 'x')
  assert.deepEqual(out.get('x')?.children, ['z'])
})

test('relations get their reverse edges at read, and a closed blocker reads as related without touching storage', () => {
  const input = [
    stored('blocker', 1, { relations: [{ type: 'blocks', id: 'blocked' }, { type: 'related', id: 'gone' }] }),
    stored('blocked', 2),
    stored('closed-blocker', 3, { status: 'landed', relations: [{ type: 'blocks', id: 'blocked' }] }),
    stored('dup', 4, { status: 'landed', relations: [{ type: 'duplicate', id: 'canonical' }] }),
    stored('canonical', 5, { relations: [{ type: 'related', id: 'blocked' }] }),
  ]
  const out = byId(issueHierarchy(input))
  assert.deepEqual(out.get('blocker')?.relations, [{ type: 'blocks', id: 'blocked' }], 'an edge to an issue not in the set is dropped')
  assert.deepEqual(out.get('blocked')?.blockedBy, ['blocker'])
  assert.deepEqual(out.get('closed-blocker')?.relations, [{ type: 'related', id: 'blocked' }])
  assert.deepEqual(out.get('blocked')?.relatedBy, ['closed-blocker', 'canonical'])
  assert.equal(out.get('dup')?.duplicateOf, 'canonical')
  assert.deepEqual(out.get('canonical')?.duplicatedBy, ['dup'])
  assert.deepEqual(input[2].relations, [{ type: 'blocks', id: 'blocked' }], 'the read never rewrites the stored edge')
})

test('a forge issue reads with an empty hierarchy and does not break the merged read', () => {
  const [issue] = issueHierarchy(fromForge({
    host: 'github',
    state: { issues: [{ number: 7, title: 't', body: '', url: 'u', state: 'OPEN', labels: [], author: 'a', createdAt: '2026-09-13T00:00:00Z', closedAt: null, comments: [] }], prs: [] },
  }, []))
  assert.equal(issue.parent, null)
  assert.deepEqual([issue.children, issue.relations, issue.blockedBy, issue.relatedBy, issue.duplicatedBy], [[], [], [], [], []])
  assert.equal(issue.duplicateOf, null)
})

test('a sub-issue inherits its parent nodes unless it names its own, and needs an open local parent', () => {
  withDisposableStore(() => {
    const epic = openIssue('the epic', { nodes: ['alpha'], author: 'test' })
    const inherits = openIssue('inherits', { parent: epic.id, author: 'test' })
    assert.equal(inherits.parent, epic.id)
    assert.deepEqual(inherits.nodes, ['alpha'])
    const own = openIssue('names its own [[gamma]]', { parent: epic.id, nodes: ['beta'], author: 'test' })
    assert.deepEqual(own.nodes, ['beta', 'gamma'])
    assert.match(readFileSync(join(process.env.SPEXCODE_ISSUES_DIR!, `${inherits.id}.md`), 'utf8'), new RegExp(`^parent: ${epic.id}$`, 'm'))
    assert.throws(() => openIssue('no parent', { parent: 'no-such-issue', author: 'test' }), /no local issue 'no-such-issue'/)
    closeLocalIssue(own.id)
    assert.throws(() => openIssue('closed parent', { parent: own.id, author: 'test' }), /is landed/)
    assert.deepEqual(byId(mergedIssues(null, [])).get(epic.id)?.children, [inherits.id, own.id])
  })
})

test('reparent moves or clears the stored pointer and refuses a cycle', () => {
  withDisposableStore(() => {
    const a = openIssue('a', { author: 'test' })
    const b = openIssue('b', { author: 'test' })
    const c = openIssue('c', { parent: a.id, author: 'test' })
    assert.equal(reparentLocalIssue(c.id, b.id).parent, b.id)
    assert.equal(reparentLocalIssue(c.id, null).parent, null)
    assert.doesNotMatch(readFileSync(join(process.env.SPEXCODE_ISSUES_DIR!, `${c.id}.md`), 'utf8'), /^parent:/m)
    assert.equal(loadOne(c.id).parent, null)
    reparentLocalIssue(b.id, a.id)
    assert.throws(() => reparentLocalIssue(a.id, b.id), /cycle/)
    assert.throws(() => reparentLocalIssue(a.id, a.id), /cycle/)
  })
})

test('relate stores the edge on the initiator once; duplicate closes it onto its canonical', () => {
  withDisposableStore(() => {
    const a = openIssue('a', { author: 'test' })
    const b = openIssue('b', { author: 'test' })
    relateLocalIssue(a.id, 'blocks', b.id)
    relateLocalIssue(a.id, 'blocks', b.id)
    assert.deepEqual(loadOne(a.id).relations, [{ type: 'blocks', id: b.id }])
    assert.deepEqual(loadOne(b.id).relations, [], 'the target stores nothing; its reverse edge is read-time')
    assert.match(readFileSync(join(process.env.SPEXCODE_ISSUES_DIR!, `${a.id}.md`), 'utf8'), new RegExp(`^relations: blocks:${b.id}$`, 'm'))
    assert.throws(() => relateLocalIssue(a.id, 'related', 'no-such-issue'), /no local issue 'no-such-issue'/)
    assert.throws(() => relateLocalIssue(a.id, 'related', a.id), /itself/)
    const dup = openIssue('dup', { author: 'test' })
    closeLocalIssue(dup.id, { duplicateOf: b.id })
    const read = byId(mergedIssues(null, []))
    assert.equal(read.get(dup.id)?.status, 'landed')
    assert.equal(read.get(dup.id)?.duplicateOf, b.id)
    assert.deepEqual(read.get(b.id)?.duplicatedBy, [dup.id])
    assert.deepEqual(read.get(b.id)?.blockedBy, [a.id])
  })
})

test('fromForge preserves platform labels and their display colors on the unified Issue', () => {
  const [issue] = fromForge({
    host: 'gitlab',
    state: {
      issues: [{
        number: 42,
        title: 'Retain platform labels',
        body: '',
        url: 'https://gitlab.example/acme/spex/-/issues/42',
        state: 'open',
        labels: [
          { name: 'bug', color: '#d73a4a', textColor: '#ffffff' },
          { name: 'triage' },
        ],
        author: 'octavia',
        createdAt: '2026-08-09T00:00:00Z',
        closedAt: null,
        comments: [],
      }],
      prs: [],
    },
  }, [])

  assert.deepEqual(issue.labels, [
    { name: 'bug', color: '#d73a4a', textColor: '#ffffff' },
    { name: 'triage' },
  ])
})

test('legacy rejected local issues stay closed in the current two-state lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spex-legacy-rejected-'))
  const previous = process.env.SPEXCODE_ISSUES_DIR
  process.env.SPEXCODE_ISSUES_DIR = dir
  try {
    writeFileSync(join(dir, 'old.md'), '---\nconcern: old decision\nby: human\nstatus: rejected\ncreated: 2026-01-01T00:00:00Z\n---\n\nNo action.\n')
    assert.equal(loadLocalIssues()[0]?.status, 'rejected')
  } finally {
    if (previous === undefined) delete process.env.SPEXCODE_ISSUES_DIR
    else process.env.SPEXCODE_ISSUES_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a local close stamps closedAt once, on the way out of open; a repeat close and an old closed file keep their bytes', () => {
  withDisposableStore(() => {
    const dir = process.env.SPEXCODE_ISSUES_DIR!
    const epic = openIssue('epic', { author: 'test' })
    const kid = openIssue('kid', { parent: epic.id, author: 'test' })
    assert.equal(loadOne(kid.id).closedAt, null)
    assert.doesNotMatch(readFileSync(join(dir, `${kid.id}.md`), 'utf8'), /^closedAt:/m, 'an open thread writes no closedAt line')

    const before = Date.now()
    assert.equal(closeLocalIssue(kid.id).already, false)
    const closedAt = loadOne(kid.id).closedAt
    assert.ok(closedAt && Date.parse(closedAt) >= before && Date.parse(closedAt) <= Date.now(), `closedAt=${closedAt}`)
    const bytes = readFileSync(join(dir, `${kid.id}.md`), 'utf8')
    assert.match(bytes, new RegExp(`^closedAt: ${closedAt}$`, 'm'))
    assert.equal(closeLocalIssue(kid.id).already, true, 'a repeat close is still the no-op')
    assert.equal(readFileSync(join(dir, `${kid.id}.md`), 'utf8'), bytes, 'and it never moves the recorded instant')

    const merged = mergedIssues(null, [])
    const parent = byId(merged).get(epic.id)!
    assert.equal(issueRefs(parent, merged)[kid.id]?.closedAt, closedAt, 'the parent read carries its child close instant')

    const dup = openIssue('dup', { author: 'test' })
    closeLocalIssue(dup.id, { duplicateOf: epic.id })
    assert.ok(loadOne(dup.id).closedAt, 'a close as a duplicate stamps the same instant')

    const legacy = '---\nconcern: shipped long ago\nby: human\nstatus: landed\ncreated: 2026-01-01T00:00:00Z\n---\n\nDone.\n'
    writeFileSync(join(dir, 'shipped-long-ago.md'), legacy)
    assert.equal(loadOne('shipped-long-ago').closedAt, null, 'a close from before the key existed reads null')
    assert.equal(closeLocalIssue('shipped-long-ago').already, true)
    assert.equal(readFileSync(join(dir, 'shipped-long-ago.md'), 'utf8'), legacy, 'the old file keeps its exact bytes')
  })
})

test('a forge issue carries the close instant its host recorded', () => {
  const row = (number: number, state: string, closedAt: string | null) =>
    ({ number, title: 't', body: '', url: 'u', state, labels: [], author: 'a', createdAt: '2026-09-13T00:00:00Z', closedAt, comments: [] })
  const [open, closed] = fromForge({ host: 'github', state: { issues: [row(1, 'OPEN', null), row(2, 'CLOSED', '2026-09-13T08:28:18Z')], prs: [] } }, [])
  assert.equal(open.closedAt, null)
  assert.equal(closed.closedAt, '2026-09-13T08:28:18Z')
})


// The landing merge is authored in a TEMPORARY DETACHED WORKTREE ([[local-issues]] and the merge skill's
// step 4), so the post-merge nudge normally runs where a store write is refused. It must not name a command
// that tree rejects; from the trunk itself nothing changes. `repoRoot()` is resolved once per process, so the
// predicate is only observable across real invocations — the same shape the hook uses.
test('post-merge nudge names `issue open` only where the store would accept it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spex-nudge-tree-'))
  const trunk = join(dir, 'trunk')
  const linked = join(dir, 'landing')
  const cli = join(import.meta.dirname, 'cli.ts')
  const run = (cwd: string) =>
    execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'internal', 'nudge', 'node/demo'], { cwd, encoding: 'utf8' })
  try {
    mkdirSync(trunk, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: trunk })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: trunk })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: trunk })
    mkdirSync(join(trunk, '.spec', 'project'), { recursive: true })
    writeFileSync(join(trunk, '.spec', 'project', 'spec.md'), '---\ntitle: project\nstatus: active\n---\nScope.\n')
    execFileSync('git', ['add', '-A'], { cwd: trunk })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: trunk })
    execFileSync('git', ['worktree', 'add', '-q', '--detach', linked, 'main'], { cwd: trunk })

    const fromTrunk = run(trunk)
    assert.match(fromTrunk, /spex issue open/, 'the trunk can commit, so it still offers the open')

    const fromLinked = run(linked)
    assert.doesNotMatch(fromLinked, /spex issue open/, 'a tree that refuses the write must not ask for it')
    assert.match(fromLinked, /does NOT work from this tree/)
    assert.match(fromLinked, /spex issue ls/, 'reads still resolve to the trunk, so keep offering the read')
    assert.match(fromLinked, /CLOSE what you finished/, 'the close half is unaffected')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A minted id keeps the concern's unicode letters, numbers, and combining marks — the characters [[spec-lint]]'s id-format and a
// `[[id]]` link already accept ([[local-issues]]), so a concern in any script gets a readable address.
test('a local issue id keeps the unicode letters, numbers, and combining marks of its concern', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spex-issue-id-'))
  const previous = process.env.SPEXCODE_ISSUES_DIR
  process.env.SPEXCODE_ISSUES_DIR = dir
  const mint = (concern: string) => openIssue(concern, { author: 'test' }).id
  try {
    assert.equal(mint('还没人认领的第二个 issue'), '还没人认领的第二个-issue')
    assert.equal(mint('纯中文 concern 开 local issue 时 id 被 mint 成 issue'), '纯中文-concern-开-local-issue-时-id-被-mint-成-issue')
    assert.equal(mint('Ελληνικά, Ünïcode!'), 'ελληνικά-ünïcode')
    assert.equal(mint('cafe\u0301 menu'), 'caf\u00e9-menu')              // NFC: a combining accent is not a separator
    assert.equal(mint('हिन्दी भाषा'), 'हिन्दी-भाषा')                    // Devanagari marks remain part of each word
    assert.equal(mint('界'.repeat(47) + '𠀀尾'), '界'.repeat(47) + '𠀀')         // 48 code points: an astral letter stays whole
    assert.equal(mint('!!! ???'), 'issue')                                      // no letter or number at all → `issue`
    assert.equal(mint('\u0301'), 'issue-2')                                     // an isolated mark still has no letter or number
    assert.equal(mint('——'), 'issue-3')
    assert.equal(mint('New'), 'new-2')                                          // the reserved address word still steps aside
  } finally {
    if (previous === undefined) delete process.env.SPEXCODE_ISSUES_DIR
    else process.env.SPEXCODE_ISSUES_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
