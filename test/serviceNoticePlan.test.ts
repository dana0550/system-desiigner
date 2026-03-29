import {describe, expect, it} from 'vitest'
import {parseServiceNoticePlan} from '../src/lib/serviceNoticePlan'

describe('parseServiceNoticePlan', () => {
  it('parses required sections and target table', () => {
    const plan = parseServiceNoticePlan(
      [
        '# Service Launch',
        '',
        '## Service Identity',
        '- service_id: payments-orchestrator',
        '- name: Payments Orchestrator',
        '',
        '## Summary',
        'Service handles payment retries.',
        '',
        '## Contract Surface',
        '- POST /v1/retries',
        '',
        '## Change Details',
        'Adds idempotency requirements.',
        '',
        '## Compatibility and Migration Guidance',
        'Clients must send an idempotency token.',
        '',
        '## Target Repositories',
        '| repo | owner | context |',
        '|------|-------|---------|',
        '| mobile-app | ios-team | update retry flow |',
        '',
      ].join('\n'),
    )

    expect(plan.serviceId).toBe('payments-orchestrator')
    expect(plan.name).toBe('Payments Orchestrator')
    expect(plan.targets).toHaveLength(1)
    expect(plan.targets[0].repo).toBe('mobile-app')
  })

  it('throws when required sections are missing', () => {
    expect(() =>
      parseServiceNoticePlan(
        [
          '## Service Identity',
          '- service_id: demo-service',
          '',
          '## Summary',
          'demo',
        ].join('\n'),
      ),
    ).toThrow(/missing required section/i)
  })
})
