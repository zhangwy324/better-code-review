declare module 'spdx-satisfies' {
  export default function satisfies(expression: string, approved: string[]): boolean;
}
