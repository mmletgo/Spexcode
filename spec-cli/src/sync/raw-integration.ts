type Edit = { start: number; end: number; text: string }

function commonCharacters(base: readonly string[], next: readonly string[], left = 0, right = base.length, start = 0, end = next.length): [number, number][] {
  const prefix: [number, number][] = [], suffix: [number, number][] = []
  while (left < right && start < end && base[left] === next[start]) prefix.push([left++, start++])
  while (left < right && start < end && base[right - 1] === next[end - 1]) suffix.push([--right, --end])
  if (left === right || start === end) return [...prefix, ...suffix.reverse()]
  if (right - left === 1) {
    const index = next.indexOf(base[left], start)
    return [...prefix, ...index >= start && index < end ? [[left, index] as [number, number]] : [], ...suffix.reverse()]
  }
  const middle = Math.floor((left + right) / 2), width = end - start
  const lengths = (from: number, to: number, reverse: boolean): Uint32Array => {
    let prior = new Uint32Array(width + 1)
    for (let offset = 0; offset < to - from; offset++) {
      const row = new Uint32Array(width + 1), character = base[reverse ? to - offset - 1 : from + offset]
      for (let column = 1; column <= width; column++) row[column] = character === next[reverse ? end - column : start + column - 1] ? prior[column - 1] + 1 : Math.max(prior[column], row[column - 1])
      prior = row
    }
    return prior
  }
  const forward = lengths(left, middle, false), backward = lengths(middle, right, true)
  let split = 0
  for (let column = 1; column <= width; column++) if (forward[column] + backward[width - column] > forward[split] + backward[width - split]) split = column
  return [...prefix, ...commonCharacters(base, next, left, middle, start, start + split), ...commonCharacters(base, next, middle, right, start + split, end), ...suffix.reverse()]
}

function textEdits(base: readonly string[], next: string): Edit[] {
  const characters = Array.from(next), edits: Edit[] = []
  let previous = 0, current = 0
  for (const [left, right] of [...commonCharacters(base, characters), [base.length, characters.length]]) {
    if (left !== previous || right !== current) edits.push({ start: previous, end: left, text: characters.slice(current, right).join('') })
    previous = left + 1; current = right + 1
  }
  return edits
}

function intersects(left: Edit, right: Edit): boolean {
  if (left.start === left.end && right.start === right.end) return left.start === right.start
  if (left.start === left.end) return right.start < left.start && left.start < right.end
  if (right.start === right.end) return left.start < right.start && right.start < left.end
  return left.start < right.end && right.start < left.end
}

/** 相容独审只处理真正重叠区域；其余共同原意与确定编辑必须逐字保留。 */
export function validateRawIntegration(base: string, source: string, delivery: string, resolved: string): string[] {
  const characters = Array.from(base)
  const edits = [...textEdits(characters, source), ...textEdits(characters, delivery)].sort((left, right) => left.start - right.start || left.end - right.end)
  const groups: Edit[][] = []
  for (const edit of edits) {
    const group = groups.at(-1)
    if (group?.some(previous => previous.start === edit.start && previous.end === edit.end && previous.text === edit.text)) continue
    if (group?.some(previous => intersects(previous, edit))) group.push(edit)
    else groups.push([edit])
  }
  const fixed = ['']
  let cursor = 0
  for (const group of groups) {
    const start = group[0].start, end = Math.max(...group.map(edit => edit.end))
    fixed[fixed.length - 1] += characters.slice(cursor, start).join('')
    if (group.length === 1) fixed[fixed.length - 1] += group[0].text
    else fixed.push('')
    cursor = end
  }
  fixed[fixed.length - 1] += characters.slice(cursor).join('')
  if (fixed.length === 1) return resolved === fixed[0] ? [] : ['raw 整合必须保持两侧确定编辑的精确合成结果']
  if (!resolved.startsWith(fixed[0]) || !resolved.endsWith(fixed.at(-1)!)) return ['raw 整合改写了真实重叠区域外的共同原意或确定编辑']
  let position = fixed[0].length
  for (const text of fixed.slice(1, -1)) {
    const index = resolved.indexOf(text, position)
    if (index < 0) return ['raw 整合未按原顺序保留重叠区域之间的共同原意或确定编辑']
    position = index + text.length
  }
  return position <= resolved.length - fixed.at(-1)!.length ? [] : ['raw 整合未保留全部共同原意或确定编辑']
}
