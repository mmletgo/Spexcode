import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { executeVerification } from '../../../src/sync/verification-executor.ts'

const [requestPath, evidenceRoot] = process.argv.slice(2)
const request = JSON.parse(await readFile(requestPath, 'utf8'))
await executeVerification(request, { onCheckpoint: async checkpoint => {
  if (checkpoint.phase === 'created') process.exit(73)
  await writeFile(join(evidenceRoot, 'process-crash-checkpoint.json'), JSON.stringify(checkpoint, null, 2))
} })
throw new Error('故障夹具必须在 created 回执前退出')
