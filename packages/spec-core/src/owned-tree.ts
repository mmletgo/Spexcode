import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** 调用方已证明拥有的树可含只读快照；只解锁实体目录，不跟随 symlink。 */
export function removeOwnedTree(path: string): void {
  const unlock = (directory: string): void => {
    if (lstatSync(directory).isDirectory()) {
      chmodSync(directory, 0o755)
      for (const name of readdirSync(directory)) unlock(join(directory, name))
    }
  }
  unlock(path)
  rmSync(path, { recursive: true, force: true })
}
