import type { WeightRecord } from 'fitdays-api'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { FitDaysSession } from './fitdays.js'

import { summarizeUser } from './summaries/user-summary.js'
import { summarizeWeight } from './summaries/weight-summary.js'

const json = (value: unknown) => ({
  content: [{ text: JSON.stringify(value, null, 2), type: 'text' as const }],
})

const joinDescriptionLines = (lines: readonly string[]): string => lines.join('\n')

const getDateStringInTimezone = (date: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date)
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970'
  const month = parts.find((p) => p.type === 'month')?.value ?? '01'
  const day = parts.find((p) => p.type === 'day')?.value ?? '01'
  return `${year}-${month}-${day}`
}

const getTimezoneOffsetMs = (date: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second'),
  )
  return asUtc - date.getTime()
}

const getDayBoundsUnixSeconds = (
  dateStr: string,
  timeZone: string,
): { endSec: number, startSec: number } => {
  const [y, m, d] = dateStr.split('-').map(Number)
  const approxStart = new Date(Date.UTC(y, m - 1, d, 0, 0, 0))
  const startOffset = getTimezoneOffsetMs(approxStart, timeZone)
  const startMs = approxStart.getTime() - startOffset

  const approxEnd = new Date(Date.UTC(y, m - 1, d, 23, 59, 59))
  const endOffset = getTimezoneOffsetMs(approxEnd, timeZone)
  const endMs = approxEnd.getTime() - endOffset

  return {
    endSec: Math.floor(endMs / 1000),
    startSec: Math.floor(startMs / 1000),
  }
}

const extensionDataDescriptionLines = [
  '`ext_data` contains the measured person\'s context and FitDays reference values for interpreting the weight metrics. Treat these as informational rather than authoritative, and adjust them to the person\'s actual situation.',
  'Context fields describe the person and measurement state, including `age`, `height`, `sex` (`female` or `male`), and `onlyMeasureWeight` (whether the record contains weight only).',
  'Range and standard fields provide reference targets: `Min` and `Max` define the reference range, while `Standard` is the recommended value. They include body-fat mass, body-fat percentage, BMI, basal metabolic rate, bone mass, muscle mass, skeletal muscle mass, protein mass, water mass, and weight fields.',
  'Control fields indicate the suggested adjustment toward the corresponding `Standard` value, including `bfmControl` (body-fat mass), `ffmControl` (fat-free mass), and `weightControl` (weight).',
  'Fat-free-mass reference fields provide the recommended fat-free mass, including `ffmStandard`.',
  'Index fields provide skeletal-muscle indexing, including `smi` (skeletal muscle index).',
  'Classification fields describe body-composition status, including `bodyScore`, `bodyType`, and `obesityDegree`.',
  'Target fields describe target body-composition values, including `targetWeight`, `targetBodyfatMass`, and `targetSMMMass`; unavailable target-mass values are `null`.',
  'Device fields identify the source device, including `deviceModelExt`, `deviceNameExt`, and `deviceSoftwareVer`.',
] as const

export const buildServer = (session: FitDaysSession): McpServer => {
  const server = new McpServer(
    {
      name: 'fitdays-mcp-server',
      version: '1.2.1',
    },
    {
      instructions: joinDescriptionLines([
        'This MCP provides access to FitDays smart-scale data.',
        '',
        'Use this MCP when the user asks about body weight, body fat, fat mass, body composition, smart-scale measurements, or health data related to weight and body composition.',
        '',
        'For daily weigh-in checks, prefer calling `get_todays_weigh_ins` to fetch all of today\'s measurements and full details in a single call.',
      ]),
    },
  )

  server.registerTool(
    'get_todays_weigh_ins',
    {
      description: joinDescriptionLines([
        'Fetch all body-composition / weight measurements for a single calendar day (defaults to today in America/Chicago or FITDAYS_TIMEZONE) in one call.',
        'Returns `date`, `timezone`, `count`, `has_weigh_in` (boolean), `latest` (the most recent weigh-in for that day with full `ext_data`, or `null` if none), and `weigh_ins` (all weigh-ins for that day ordered newest first).',
        'By default forces a fresh sync (`refresh: true`) and excludes deleted records (`include_deleted: false`) while including full `ext_data` (`include_ext_data: true`).',
        ...extensionDataDescriptionLines,
      ]),
      inputSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('Calendar date in YYYY-MM-DD format. Defaults to today in the configured timezone.'),
        include_deleted: z.boolean().optional()
          .describe('Include records with `is_deleted: 1`. Default: false.'),
        include_ext_data: z.boolean().optional()
          .describe('Include the `ext_data` reference/context object. Default: true.'),
        refresh: z.boolean().optional()
          .describe('Force-refresh from FitDays before reading. Default: true.'),
        suid: z.number().int().optional()
          .describe('Optional sub-user id. Omit to include all users on the account.'),
        timezone: z.string().optional()
          .describe('IANA timezone name (e.g. America/Chicago). Defaults to FITDAYS_TIMEZONE or America/Chicago.'),
      },
      title: 'Today\'s weigh-ins',
    },
    async ({ date, include_deleted, include_ext_data, refresh, suid, timezone }) => {
      const tz = timezone ?? process.env.FITDAYS_TIMEZONE ?? 'America/Chicago'
      const targetDate = date ?? getDateStringInTimezone(new Date(), tz)
      const { endSec, startSec } = getDayBoundsUnixSeconds(targetDate, tz)
      const includeDeleted = include_deleted ?? false
      const includeExtensionData = include_ext_data ?? true
      const forceRefresh = refresh ?? true

      const data = await session.getSync(forceRefresh)
      const weighIns = data.weight_list
        .filter((r) => includeDeleted || r.is_deleted === 0)
        .filter((r) => suid === undefined || r.suid === suid)
        .filter((r) => r.measured_time >= startSec && r.measured_time <= endSec)
        .sort((a, b) => b.measured_time - a.measured_time)
        .map((r) => summarizeWeight(r, includeExtensionData))

      return json({
        count: weighIns.length,
        date: targetDate,
        has_weigh_in: weighIns.length > 0,
        latest: weighIns[0] ?? null,
        timezone: tz,
        weigh_ins: weighIns,
      })
    },
  )

  server.registerTool(
    'list_users',
    {
      description: joinDescriptionLines([
        'List the sub-users (people) registered under the FitDays account.',
        'Each user has a unique and stable `suid`, used by other tools to query data for that user.',
        'Returns a list where each entry contains `nickname`, `sex` (`male` or `female`, biological sex), `birthday`, `height_cm`, `target_weight_kg` (user-set target weight), `suid`, and `uid` (account uid).',
      ]),
      inputSchema: {},
      title: 'List FitDays users',
    },
    async () => {
      const data = await session.getSync()
      return json(data.users.filter((u) => u.is_deleted === 0).map(summarizeUser))
    },
  )

  server.registerTool(
    'list_devices',
    {
      description: joinDescriptionLines([
        'List the devices bound to the FitDays account.',
        'Returns `device_id` (FitDays device identifier), `name`, `model`, `mac` (MAC address), and `firmware_ver` (firmware version) for each device.',
      ]),
      inputSchema: {},
      title: 'List FitDays devices',
    },
    async () => {
      const data = await session.getSync()
      return json(data.devices.map((d) => ({
        device_id: d.device_id,
        firmware_ver: d.firmware_ver,
        mac: d.mac,
        model: d.model,
        name: d.name,
      })))
    },
  )

  server.registerTool(
    'get_weight_history',
    {
      description: joinDescriptionLines([
        'Return body-composition / weight measurements, optionally filtered by sub-user (`suid`) and time window.',
        'Data is fetched lazily when no valid cache exists and stored in a global cache shared by all tools for 5 minutes; subsequent queries use that cached snapshot until it expires. Use `refresh_sync` if you are within the 5-minute cache window and fresher data is required.',
        'Returns a list ordered newest first. Each measurement contains `weight_kg`, `weight_lb`, `bmi`, `bfr_pct` (body fat percentage), `rom_pct` (muscle percentage), `rosm_pct` (skeletal muscle percentage), `vwc_pct` (body water percentage), `pp_pct` (protein percentage), `sfr_pct` (subcutaneous fat percentage), `uvi` (visceral fat index), `bm_kg` (bone mass), `bmr_kcal` (basal metabolic rate), `bodyage` (body age), `measured_at` (ISO 8601 timestamp), `measured_time` (Unix-seconds timestamp), `data_id`, `suid`, `uid`, and `is_deleted`. Set `include_ext_data: true` to also return `ext_data` for each record.',
        ...extensionDataDescriptionLines,
        'By default includes tombstoned records (`is_deleted: 1`); set `include_deleted: false` to hide them.',
      ]),
      inputSchema: {
        include_deleted: z.boolean().optional()
          .describe('Include records with `is_deleted: 1` (server-side tombstones). Default: true.'),
        include_ext_data: z.boolean().optional()
          .describe('Include the `ext_data` reference/context object on each record. Leave it off when only the measurements are needed, such as for plotting trends. Default: false.'),
        limit: z.number().int().positive().max(1000).optional()
          .describe('Maximum number of records (newest first). Default: 100.'),
        since: z.number().int().nonnegative().optional()
          .describe('Only include records measured at or after this unix-seconds timestamp.'),
        suid: z.number().int().optional()
          .describe('Sub-user id resolved by `list_users`. Omit to return records for all users.'),
        until: z.number().int().nonnegative().optional()
          .describe('Only include records measured at or before this unix-seconds timestamp.'),
      },
      title: 'Weight history',
    },
    async ({ include_deleted, include_ext_data, limit, since, suid, until }) => {
      const includeDeleted = include_deleted ?? true
      const includeExtensionData = include_ext_data ?? false
      const data = await session.getSync()
      const records = data.weight_list
        .filter((r) => includeDeleted || r.is_deleted === 0)
        .filter((r) => suid === undefined || r.suid === suid)
        .filter((r) => since === undefined || r.measured_time >= since)
        .filter((r) => until === undefined || r.measured_time <= until)
        .sort((a, b) => b.measured_time - a.measured_time)
        .slice(0, limit ?? 100)
        .map((weightRecord) => summarizeWeight(weightRecord, includeExtensionData))
      return json(records)
    },
  )

  server.registerTool(
    'get_latest_weight',
    {
      description: joinDescriptionLines([
        'Return the most recent body-composition / weight measurement in the current global cache, optionally for a single sub-user (`suid`).',
        'Data is fetched lazily when no valid cache exists and stored in a global cache shared by all tools for 5 minutes; subsequent queries use that cached snapshot until it expires. Use `refresh_sync` if you are within the 5-minute cache window and fresher data is required.',
        'Returns exactly one measurement containing `weight_kg`, `weight_lb`, `bmi`, `bfr_pct` (body fat percentage), `rom_pct` (muscle percentage), `rosm_pct` (skeletal muscle percentage), `vwc_pct` (body water percentage), `pp_pct` (protein percentage), `sfr_pct` (subcutaneous fat percentage), `uvi` (visceral fat index), `bm_kg` (bone mass), `bmr_kcal` (basal metabolic rate), `bodyage` (body age), `measured_at` (ISO 8601 timestamp), `measured_time` (Unix-seconds timestamp), `data_id`, `suid`, `uid`, `is_deleted`, and `ext_data`, or `null` if no matching measurement exists.',
        ...extensionDataDescriptionLines,
        'By default ignores tombstoned records (`is_deleted: 1`).',
      ]),
      inputSchema: {
        include_deleted: z.boolean().optional()
          .describe('Include records with `is_deleted: 1`. Default: false.'),
        include_ext_data: z.boolean().optional()
          .describe('Include the `ext_data` reference/context object. Set to false to omit it. Default: true.'),
        suid: z.number().int().optional()
          .describe('Sub-user id resolved by `list_users`. Omit to return the latest record across all users.'),
      },
      title: 'Latest weight',
    },
    async ({ include_deleted, include_ext_data, suid }) => {
      const includeDeleted = include_deleted ?? false
      const includeExtensionData = include_ext_data ?? true
      const data = await session.getSync()
      const latest = data.weight_list
        .filter((r) => includeDeleted || r.is_deleted === 0)
        .filter((r) => suid === undefined || r.suid === suid)
        .reduce<null | WeightRecord>((acc, r) => {
          return acc === null || r.measured_time > acc.measured_time ? r : acc
        }, null)
      return json(latest ? summarizeWeight(latest, includeExtensionData) : null)
    },
  )

  server.registerTool(
    'refresh_sync',
    {
      description: joinDescriptionLines([
        'Force-refresh the global FitDays cache shared by all tools.',
        'FitDays data is loaded lazily: the first tool call that needs synchronized account data fetches a fresh snapshot and stores it in the global cache for 5 minutes.',
        'Returns synchronized record counts for `devices`, `users`, `height_records`, and `weight_records` (`active`, `deleted`, `total`).',
      ]),
      inputSchema: {},
      title: 'Refresh sync cache',
    },
    async () => {
      const data = await session.getSync(true)
      const activeWeight = data.weight_list.filter((r) => r.is_deleted === 0).length
      return json({
        devices: data.devices.length,
        height_records: data.height_list.length,
        users: data.users.length,
        weight_records: {
          active: activeWeight,
          deleted: data.weight_list.length - activeWeight,
          total: data.weight_list.length,
        },
      })
    },
  )

  return server
}
