import {describe, expect, it} from 'vitest'
import {parseBootstrapQuickTarget} from '../src/lib/bootstrapQuick'
import {resolveConsumerTargetDir} from '../src/lib/bootstrapConsumer'

describe('parseBootstrapQuickTarget', () => {
  it('parses org/repo format', () => {
    expect(parseBootstrapQuickTarget('dana0550/custom-design')).toEqual({
      org: 'dana0550',
      designRepo: 'custom-design',
    })
  })

  it('parses org-only format with default repo', () => {
    expect(parseBootstrapQuickTarget('dana0550')).toEqual({
      org: 'dana0550',
      designRepo: 'dana0550-system-designer',
    })
  })

  it('resolves org-only quick target to dedicated default workspace path', () => {
    const target = parseBootstrapQuickTarget('acme')
    expect(resolveConsumerTargetDir('dedicated', target.designRepo, undefined, '/workspace/root')).toBe(
      '/workspace/root/acme-system-designer',
    )
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
