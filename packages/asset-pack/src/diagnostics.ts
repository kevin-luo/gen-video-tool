import type {
  AssetPackDiagnostic,
  DiagnosticCode,
  DiagnosticSeverity,
} from './types';

export const diagnostic = (
  code: DiagnosticCode,
  severity: DiagnosticSeverity,
  message: string,
  options: {
    path?: string | null;
    assetPath?: string | null;
    suggestion?: string | null;
  } = {},
): AssetPackDiagnostic => ({
  code,
  severity,
  path: options.path ?? null,
  assetPath: options.assetPath ?? null,
  message,
  suggestion: options.suggestion ?? null,
});

export const hasBlockingDiagnostics = (
  diagnostics: readonly AssetPackDiagnostic[],
): boolean => diagnostics.some((item) => item.severity === 'error');

export const sortDiagnostics = (
  diagnostics: readonly AssetPackDiagnostic[],
): AssetPackDiagnostic[] => [...new Map(diagnostics.map((item) => [
  [item.code, item.severity, item.path, item.assetPath, item.message, item.suggestion].join('\u0001'),
  item,
])).values()].sort((left, right) => {
  const severityRank = {error: 0, warning: 1, info: 2} as const;
  return (
    severityRank[left.severity] - severityRank[right.severity] ||
    (left.assetPath ?? '').localeCompare(right.assetPath ?? '') ||
    (left.path ?? '').localeCompare(right.path ?? '') ||
    left.code.localeCompare(right.code)
  );
});
