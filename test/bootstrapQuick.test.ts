import {describe, expect, it} from 'vitest'
import {parseBootstrapQuickTarget} from '../src/lib/bootstrapQuick'

describe('parseBootstrapQuickTarget', () => {
  it('parses org/repo format', () => {
    expect(parseBootstrapQuickTarget('dana0550/system-design')).toEqual({
      org: 'dana0550',
      designRepo: 'system-design',
    })
  })

  it('parses org-only format with default repo', () => {
    expect(parseBootstrapQuickTarget('dana0550')).toEqual({
      org: 'dana0550',
      designRepo: 'system-design',
    })
  })

  it('parses GitHub URL format', () => {
    expect(parseBootstrapQuickTarget('https://github.com/dana0550/system-design.git')).toEqual({
      org: 'dana0550',
      designRepo: 'system-design',
    })
  })

  it('rejects invalid targets', () => {
    expect(() => parseBootstrapQuickTarget('too/many/parts')).toThrow(/Invalid target/)
    expect(() => parseBootstrapQuickTarget('')).toThrow(/Invalid target/)
  })
})
