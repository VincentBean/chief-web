export {
  ConflictFixError,
  type ConflictFixOutcome,
  type ConflictFixPhase,
  type ConflictFixRefusal,
  createPrConflictFixService,
  PrConflictFixService,
} from './fix.js';
export {
  abortMerge,
  isNonFastForward,
  type MergeAttempt,
  type MergeCode,
  mergeExecSpec,
  type MergeInput,
  mergeScript,
  type MergeStep,
  runBaseMerge,
  unmergedPaths,
  type VerifyCode,
  type VerifyInput,
  type VerifyResult,
  verifyResolution,
} from './merge.js';
export {
  type ConflictPromptInput,
  conflictResolutionPrompt,
  descriptionOf,
} from './prompts.js';
export {
  CHIEF_BRANCH_PREFIX,
  type ConflictedPullRequest,
  type ConflictFixStarter,
  type ConflictScan,
  type ConflictScanGateway,
  createPrConflictScan,
  GithubConflictScan,
  isCandidate,
  PrConflictService,
} from './service.js';
