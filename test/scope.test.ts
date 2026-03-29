import {describe, expect, it} from 'vitest'
import {computeEffectiveScope} from '../src/lib/scope'

describe('computeEffectiveScope', () => {
  it('computes effective set from discovered, include, and exclude', () => {
    const result = computeEffectiveScope(
      ['api', 'billing', 'frontend'],
      ['notifications'],
      ['frontend'],
    )

    expect(result).toEqual(['api', 'billing', 'notifications'])
  })

  it('throws when a repo appears in include and exclude', () => {
    expect(() => computeEffectiveScope(['api'], ['api'], ['api'])).toThrow(/include and exclude/)
  })
})
