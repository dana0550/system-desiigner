export interface ServiceNoticeTarget {
  repo: string
  owner: string
  context: string
}

export interface ServiceNoticePlan {
  serviceId: string
  name: string
  summary: string
  contractSurface: string
  changeDetails: string
  migrationGuidance: string
  targets: ServiceNoticeTarget[]
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function splitMarkdownTableRow(value: string): string[] {
  return value
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((part) => part.trim())
}

function parseSections(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {}
  const lines = markdown.split(/\r?\n/)
  let current = ''
  let buffer: string[] = []

  const flush = (): void => {
    if (!current) {
      return
    }

    sections[current] = buffer.join('\n').trim()
    buffer = []
  }

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      flush()
      current = heading[1].trim()
      continue
    }

    if (current) {
      buffer.push(line)
    }
  }

  flush()
  return sections
}

function parseTargets(section: string): ServiceNoticeTarget[] {
  const tableLines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))

  if (tableLines.length < 2) {
    throw new Error(
      'Service plan section "Target Repositories" must include a markdown table with header and separator.',
    )
  }

  const header = splitMarkdownTableRow(tableLines[0]).map((value) => value.toLowerCase())
  const required = ['repo', 'owner', 'context']
  const missing = required.filter((name) => !header.includes(name))
  if (missing.length > 0) {
    throw new Error(`Service plan target table is missing required columns: ${missing.join(', ')}`)
  }

  const targets: ServiceNoticeTarget[] = []
  for (const line of tableLines.slice(2)) {
    const row = splitMarkdownTableRow(line)
    const object: Record<string, string> = {}
    for (let i = 0; i < header.length; i += 1) {
      object[header[i]] = row[i] ?? ''
    }

    if (!object.repo.trim() && !object.owner.trim() && !object.context.trim()) {
      continue
    }

    targets.push({
      repo: object.repo.trim(),
      owner: object.owner.trim(),
      context: object.context.trim(),
    })
  }

  if (targets.length === 0) {
    throw new Error('Service plan target table must include at least one target row.')
  }

  return targets
}

function parseIdentity(section: string): {serviceId: string; name: string} {
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const map: Record<string, string> = {}
  for (const line of lines) {
    const match = line.match(/^[-*]\s*([a-zA-Z0-9_ -]+):\s*(.+)$/)
    if (!match) {
      continue
    }

    const key = match[1].trim().toLowerCase().replace(/\s+/g, '_')
    map[key] = match[2].trim()
  }

  const rawName = map.name ?? map.service_name ?? ''
  const rawServiceId = map.service_id ?? map.id ?? ''

  if (!rawName && !rawServiceId) {
    throw new Error(
      'Service plan "Service Identity" section must include bullet keys for at least "name" or "service_id".',
    )
  }

  const name = rawName || rawServiceId
  const serviceId = rawServiceId || slugify(rawName)
  if (!serviceId) {
    throw new Error('Unable to derive service_id from "Service Identity" section.')
  }

  return {serviceId, name}
}

function requireSection(sections: Record<string, string>, key: string): string {
  const value = sections[key]
  if (!value || value.trim().length === 0) {
    throw new Error(`Service plan is missing required section: "## ${key}"`)
  }

  return value.trim()
}

export function parseServiceNoticePlan(markdown: string): ServiceNoticePlan {
  const sections = parseSections(markdown)
  const identity = parseIdentity(requireSection(sections, 'Service Identity'))
  const summary = requireSection(sections, 'Summary')
  const contractSurface = requireSection(sections, 'Contract Surface')
  const migrationGuidance = requireSection(sections, 'Compatibility and Migration Guidance')
  const targetSection = requireSection(sections, 'Target Repositories')
  const targets = parseTargets(targetSection)
  const changeDetails = sections['Change Details']?.trim() || 'See service plan for implementation details.'

  return {
    serviceId: identity.serviceId,
    name: identity.name,
    summary,
    contractSurface,
    changeDetails,
    migrationGuidance,
    targets,
  }
}
