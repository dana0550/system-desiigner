import {run as oclifRun} from '@oclif/core'

export async function run(): Promise<void> {
  await oclifRun()
}

if (require.main === module) {
  run().catch(require('@oclif/core/handle'))
}
