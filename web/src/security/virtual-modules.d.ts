// Made by the build (vite.config.ts): for each refusal code, the contract test lines that name it.
declare module 'virtual:refusal-tests' {
  const tests: Record<string, { path: string; line: number }[]>;
  export default tests;
}
