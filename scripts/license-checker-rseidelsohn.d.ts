// Minimal types for the parts of license-checker-rseidelsohn we use; the package ships none.
declare module 'license-checker-rseidelsohn' {
  export interface ModuleInfo {
    licenses?: string | string[];
    repository?: string;
    licenseFile?: string;
  }
  export type ModuleInfos = Record<string, ModuleInfo>;
  export interface InitOptions {
    start: string;
    production?: boolean;
    excludePrivatePackages?: boolean;
  }
  export function init(
    options: InitOptions,
    callback: (err: Error | null, result: ModuleInfos) => void,
  ): void;
}
