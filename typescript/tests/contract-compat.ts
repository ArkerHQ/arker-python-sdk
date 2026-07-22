import type {
  Filesystem,
  ListFilesystemsResponse,
  ListOrgRunsResponse,
  ListRunsResponse,
  ListSessionsResponse,
  ListVmsResponse,
  OrgRunListRow,
  Run,
  RunSummary,
  Session,
  Vm,
} from "../src/index.js";

declare const sessionFields: Omit<Session, "provider">;
const burstSession: Session = { ...sessionFields, provider: "aws-burst" };

declare const vmFields: Omit<Vm, "provider" | "sessions">;
const burstVm: Vm = {
  ...vmFields,
  provider: "aws-burst",
  sessions: [burstSession],
};

declare const runFields: Omit<Run, "provider">;
const burstRun: Run = { ...runFields, provider: "aws-burst" };

declare const runSummaryFields: Omit<RunSummary, "provider">;
const burstRunSummary: RunSummary = {
  ...runSummaryFields,
  provider: "aws-burst",
};

declare const filesystemFields: Omit<Filesystem, "provider">;
const burstFilesystem: Filesystem = {
  ...filesystemFields,
  provider: "aws-burst",
};

declare const orgRunFields: Omit<
  OrgRunListRow,
  | "source"
  | "lambda_call_ms"
  | "lambda_duration_ms"
  | "lambda_cpu_ms"
  | "lambda_mem_mb"
>;
const lambdaRun: OrgRunListRow = {
  ...orgRunFields,
  source: "cf",
  lambda_call_ms: 1,
  lambda_duration_ms: 2,
  lambda_cpu_ms: 3,
  lambda_mem_mb: 4,
};

const vmList: ListVmsResponse = { vms: [burstVm] };
const sessionList: ListSessionsResponse = { sessions: [burstSession] };
const runList: ListRunsResponse = { runs: [burstRunSummary] };
const filesystemList: ListFilesystemsResponse = {
  filesystems: [burstFilesystem],
};
declare const orgRunListFields: Omit<ListOrgRunsResponse, "rows">;
const orgRunList: ListOrgRunsResponse = {
  ...orgRunListFields,
  rows: [lambdaRun],
};

void [vmList, sessionList, runList, filesystemList, orgRunList, burstRun];
