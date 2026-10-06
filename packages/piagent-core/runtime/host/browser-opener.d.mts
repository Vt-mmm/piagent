export function browserCommand(url: string, options?: { platform?: NodeJS.Platform; environment?: Readonly<Record<string, string | undefined>> }):
  { command: string; args: string[]; options?: { cwd?: string } } | null;
