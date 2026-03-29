export const APP_DIR = '.sdx'
export const CONFIG_FILE = 'config.json'
export const DB_FILE = 'state.db'
export const SCHEMA_VERSION = '1.0.0'

export const REQUIRED_NFR_KEYWORDS = [
  'latency',
  'availability',
  'durability',
  'slo',
  'failure',
]

export const PRIMER_DIMENSIONS = [
  'scalability',
  'reliability',
  'consistency_model',
  'data_design',
  'api_style',
  'caching',
  'async_patterns',
  'security',
  'observability',
  'operational_tradeoffs',
] as const
