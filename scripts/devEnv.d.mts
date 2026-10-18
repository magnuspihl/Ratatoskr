export function mainCheckoutDir(cwd: string): string | null;
export function devEnvFiles(cwd: string, main?: string | null): string[];
export function loadDevEnv(
  cwd: string,
  env?: Record<string, string | undefined>,
  main?: string | null,
): { env: Record<string, string | undefined>; files: string[] };
