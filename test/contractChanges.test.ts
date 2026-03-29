import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  computeContractChangeStatus,
  ContractChangeDoc,
  hasContractChangeIndexShape,
  nextContractChangeId,
  parseContractChangeIndexText,
  readContractChangeDoc,
  readContractChangeIndex,
  renderContractChangeDoc,
  renderContractChangeIndex,
  resolveContractDocAbsolutePath,
} from '../src/lib/contractChanges'

const tempDirs: string[] = []

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-contract-changes-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  }
})

describe('contract change parsing', () => {
  it('parses index rows and resolves docs/contracts paths', () => {
    const root = mkTempDir()
    fs.mkdirSync(path.join(root, 'docs', 'contracts'), {recursive: true})

    fs.writeFileSync(
      path.join(root, 'docs', 'CONTRACT_CHANGES.md'),
      [
        '---',
        'doc_type: contract_change_index',
        'version: 2.4.0',
        'last_synced: 2026-03-29',
        '---',
        '# Contract Changes Index',
        '',
        '| ID | Name | Status | Change Type | Owner | Path | Aliases |',
        '|----|------|--------|-------------|-------|------|---------|',
        '| CC-101 | Billing event v2 | approved | event | platform | contracts/CC-101.md | billing-v2 |',
        '',
      ].join('\n'),
      'utf8',
    )

    fs.writeFileSync(
      path.join(root, 'docs', 'contracts', 'CC-101.md'),
      [
        '---',
        'doc_type: contract_change',
        'contract_change_id: CC-101',
        'name: Billing event v2',
        'status: approved',
        'change_type: event',
        'owner: platform',
        'last_updated: 2026-03-29',
        '---',
        '# Billing event v2',
        '',
        '## Summary',
        'Adds a new billing event version.',
        '',
        '## Contract Surface',
        '- topic: billing.events.v2',
        '',
        '## Change Details',
        'Payload adds `currency` field.',
        '',
        '## Compatibility and Migration Guidance',
        'Consumers should support both versions during rollout.',
        '',
        '## Downstream Notification Context',
        '| repo | owner | context | pr_url | state |',
        '|------|-------|---------|--------|-------|',
        '| service-a | billing-team | update consumer |  | pending |',
        '',
      ].join('\n'),
      'utf8',
    )

    const index = readContractChangeIndex(path.join(root, 'docs', 'CONTRACT_CHANGES.md'))
    expect(index.rows).toHaveLength(1)
    expect(index.rows[0].contractChangeId).toBe('CC-101')

    const absolute = resolveContractDocAbsolutePath(root, 'CC-101', index.rows[0].path)
    expect(absolute).toBe(path.join(root, 'docs', 'contracts', 'CC-101.md'))

    const doc = readContractChangeDoc(root, index.rows[0])
    expect(doc.contractChangeId).toBe('CC-101')
    expect(doc.targets).toHaveLength(1)
    expect(doc.targets[0].state).toBe('pending')
  })

  it('round-trips index/doc rendering and applies status transitions', () => {
    const doc: ContractChangeDoc = {
      contractChangeId: 'CC-102',
      name: 'Order API v2',
      status: 'approved',
      changeType: 'api',
      owner: 'orders',
      lastUpdated: '2026-03-29',
      absolutePath: '/tmp/docs/contracts/CC-102.md',
      relativePath: 'docs/contracts/CC-102.md',
      sections: {
        summary: 'Introduce a new endpoint.',
        contractSurface: '- POST /v2/orders',
        changeDetails: 'Adds optional metadata.',
        compatibilityAndMigrationGuidance: 'Old endpoint remains for 90 days.',
      },
      targets: [
        {repo: 'service-a', owner: 'orders-team', context: 'API client', prUrl: '', state: 'opened'},
        {repo: 'service-b', owner: 'orders-team', context: 'API client', prUrl: '', state: 'merged'},
      ],
    }

    const rendered = renderContractChangeDoc(doc)
    expect(rendered).toContain('contract_change_id: CC-102')
    expect(rendered).toContain('| service-a | orders-team | API client |  | opened |')

    const nextStatus = computeContractChangeStatus('approved', doc.targets)
    expect(nextStatus).toBe('published')
    expect(computeContractChangeStatus('published', [{...doc.targets[1]}])).toBe('closed')

    const index = renderContractChangeIndex(
      [
        {
          contractChangeId: 'CC-102',
          name: 'Order API v2',
          status: nextStatus,
          changeType: 'api',
          owner: 'orders',
          path: 'docs/contracts/CC-102.md',
          aliases: 'order-v2',
        },
      ],
      {docType: 'contract_change_index', version: '2.4.0'},
    )

    expect(index).toContain('| CC-102 | Order API v2 | published | api | orders | docs/contracts/CC-102.md | order-v2 |')
    expect(hasContractChangeIndexShape(index)).toBe(true)
    const parsed = parseContractChangeIndexText(index)
    expect(nextContractChangeId(parsed.rows)).toBe('CC-103')
  })
})
