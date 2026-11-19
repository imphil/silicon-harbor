import { z } from "zod"

/**
 * Schemas for Devsy CLI output, as recorded in test/fixtures/devsy/ and
 * described in docs/devsy-contract.md. Unknown fields are ignored (zod strips
 * them) so newer Devsy versions with extra fields keep working.
 */

export const CliErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().default(""),
  hint: z.string().optional(),
  context: z.record(z.string()).optional(),
})
export type CliErrorInfo = z.infer<typeof CliErrorSchema>

export const TaskEnvelopeSchema = z.object({
  kind: z.literal("task"),
  id: z.string().min(1),
  runId: z.string().optional(),
})
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>

export const StatusEnvelopeSchema = z.object({
  kind: z.literal("status"),
  schemaVersion: z.number().optional(),
  pipeline: z.string().optional(),
  operationId: z.string().optional(),
  parentOperationId: z.string().optional(),
  phase: z.string(),
  step: z.string().optional(),
  state: z.enum(["started", "succeeded", "failed", "skipped"]),
  durationMs: z.number().optional(),
  error: CliErrorSchema.optional(),
})
export type StatusEnvelope = z.infer<typeof StatusEnvelopeSchema>

export const ResultEnvelopeSchema = z.object({
  kind: z.literal("result"),
  outcome: z.string().optional(),
  containerId: z.string().optional(),
  remoteUser: z.string().optional(),
  remoteWorkspaceFolder: z.string().optional(),
  url: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  runId: z.string().optional(),
})
export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>

export const ErrorEnvelopeSchema = CliErrorSchema.extend({
  kind: z.literal("error"),
  outcome: z.string().optional(),
})
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

/** A zap JSON log line (stderr). */
export const LogRecordSchema = z.object({
  level: z.string().optional(),
  ts: z.union([z.string(), z.number()]).optional(),
  msg: z.string(),
})
export type LogRecord = z.infer<typeof LogRecordSchema>

export const EnvelopeSchema = z.discriminatedUnion("kind", [
  TaskEnvelopeSchema,
  StatusEnvelopeSchema,
  ResultEnvelopeSchema,
  ErrorEnvelopeSchema,
])
export type Envelope = z.infer<typeof EnvelopeSchema>

export type ParsedLine =
  | { type: "envelope"; envelope: Envelope }
  | { type: "log"; record: LogRecord }
  | { type: "text"; text: string }

/** Classifies one output line of the CLI. Never throws. */
export function parseLine(line: string): ParsedLine | undefined {
  const text = line.trim()
  if (text === "") return undefined
  if (text.startsWith("{")) {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return { type: "text", text }
    }
    const envelope = EnvelopeSchema.safeParse(json)
    if (envelope.success) return { type: "envelope", envelope: envelope.data }
    const record = LogRecordSchema.safeParse(json)
    if (record.success) return { type: "log", record: record.data }
  }
  return { type: "text", text }
}

// ---------------------------------------------------------------------------
// Command results

export const WorkspaceListEntrySchema = z.object({
  id: z.string(),
  uid: z.string().optional(),
  provider: z.object({ name: z.string().optional() }).partial().optional(),
  ide: z.object({ name: z.string().optional() }).partial().optional(),
  source: z
    .object({
      gitRepository: z.string().optional(),
      gitBranch: z.string().optional(),
      gitCommit: z.string().optional(),
      gitPRReference: z.string().optional(),
      gitSubDir: z.string().optional(),
      localFolder: z.string().optional(),
      image: z.string().optional(),
    })
    .partial()
    .optional(),
  creationTimestamp: z.string().optional(),
  lastUsed: z.string().optional(),
  context: z.string().optional(),
  displayName: z.string().optional(),
  effectiveDisplayName: z.string().optional(),
})
export type WorkspaceListEntry = z.infer<typeof WorkspaceListEntrySchema>
export const WorkspaceListSchema = z.array(WorkspaceListEntrySchema)

export const WorkspaceStatusSchema = z.object({
  id: z.string(),
  context: z.string().optional(),
  provider: z.string().optional(),
  state: z.string(),
  lastOperation: z
    .object({
      timestamp: z.string().optional(),
      pipeline: z.string().optional(),
      phase: z.string().optional(),
      state: z.string().optional(),
      durationMillis: z.number().optional(),
      error: CliErrorSchema.optional(),
    })
    .optional(),
})
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>

export const TaskRecordSchema = z.object({
  id: z.string(),
  command: z.string().optional(),
  workspaceId: z.string().optional(),
  runId: z.string().optional(),
  status: z.string(),
  phase: z.string().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  errorHint: z.string().optional(),
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
})
export type TaskRecord = z.infer<typeof TaskRecordSchema>
export const TaskListSchema = z.array(TaskRecordSchema)

export const SetupLogRecordSchema = z.object({
  kind: z.string(),
  producerId: z.string().optional(),
  sequence: z.number().optional(),
  time: z.string().optional(),
  stream: z.string().optional(),
  text: z.string().optional(),
  hook: z.string().optional(),
  state: z.string().optional(),
  reason: z.string().optional(),
})
export type SetupLogRecord = z.infer<typeof SetupLogRecordSchema>
export const SetupLogReadSchema = z.object({
  schemaVersion: z.number().optional(),
  run: z.object({ runId: z.string().optional() }).partial().optional(),
  records: z.array(SetupLogRecordSchema).default([]),
  /** Pass as --after to read only what came later. */
  nextCursor: z.string().optional(),
  hasMore: z.boolean().optional(),
})
export type SetupLogRead = z.infer<typeof SetupLogReadSchema>

/** `provider list`: an object keyed by provider name. */
export const ProviderListSchema = z.record(z.unknown())
