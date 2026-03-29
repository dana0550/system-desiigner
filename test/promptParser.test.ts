import {describe, expect, it} from 'vitest'
import {parsePromptIntent} from '../src/lib/promptParser'

describe('parsePromptIntent', () => {
  it('parses include intent', () => {
    const intent = parsePromptIntent('include billing-api and notifications')
    expect(intent.action).toBe('include')
    expect(intent.repos).toContain('billing-api')
  })

  it('parses exclude intent', () => {
    const intent = parsePromptIntent('remove legacy-service from map')
    expect(intent.action).toBe('exclude')
    expect(intent.repos).toContain('legacy-service')
  })

  it('parses status intent', () => {
    const intent = parsePromptIntent('show status')
    expect(intent.action).toBe('status')
  })

  it('parses build intent', () => {
    const intent = parsePromptIntent('build the map now')
    expect(intent.action).toBe('build')
  })

  it('filters prompt repo extraction to known repos', () => {
    const intent = parsePromptIntent('exclude repo-b from map', ['repo-a', 'repo-b'])
    expect(intent.action).toBe('exclude')
    expect(intent.repos).toEqual(['repo-b'])
  })

  it('matches org/repo forms to known repo names', () => {
    const intent = parsePromptIntent('include acme/repo-a and acme/repo-b', ['repo-a', 'repo-b'])
    expect(intent.action).toBe('include')
    expect(intent.repos).toEqual(['repo-a', 'repo-b'])
  })
})
