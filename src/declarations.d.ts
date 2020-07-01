declare module 'argparse'
declare module 'fs-extra'
declare module 'puppeteer-core'
declare module 'tmp'
declare module 'xvfb'

type Url = string
type FilePath = string
type ErrorMsg = string
type DebugLevel = 'none' | 'debug' | 'verbose'

interface CrawlArgs {
  executablePath: FilePath,
  outputPath: FilePath,
  urls: Url[],
  withShieldsUp: boolean,
  debugLevel: DebugLevel,
  seconds: number,
  existingProfilePath?: FilePath,
  persistProfilePath?: FilePath,
  interactive: boolean,
  userAgent?: string
}

type ValidationResult = [boolean, CrawlArgs | ErrorMsg]

interface LoggerFunc {
  (message?: string, ...optional: any[]): void;
}

interface Logger {
  debug: LoggerFunc,
  verbose: LoggerFunc
}

interface TearDownEnvFunc {
  (): void
}

interface EnvHandle {
  close: TearDownEnvFunc
}

interface PageFinalPageGraph {
  data: string
}

type TabSnapEnd = 'active' | 'closed' | 'navigated';

interface TabSnapshot {
  url: string,
  end: TabSnapEnd,
  pageGraphML?: string
}

interface TabTreeNode {
  parent?: TabTreeNode,
  parentSnapshot?: TabSnapshot,
  children?: TabTreeNode[],
  snapshots: TabSnapshot[]
}

interface TabTreeCloseFunc {
  (): Promise<void>
}

interface TabTreeDumpFunc {
  (outputPath: string): Promise<string>
}

interface TabTreeTracker {
  close: TabTreeCloseFunc,
  dump: TabTreeDumpFunc
}