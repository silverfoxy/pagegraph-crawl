declare module 'argparse'
declare module 'fs-extra'
declare module 'puppeteer-core'
declare module 'tmp'
declare module 'xvfb'

type Url = string
type FilePath = string
type ErrorMsg = string
type DebugLevel = 'none' | 'debug' | 'verbose'
type TrackerStrategy = 'single' | 'multi'

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
  userAgent?: string,
  trackerFactory: TargetTrackerFactory,
  proxyServer?: URL,
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
  frameId: string,
  data: string
}

interface PageFrameAttached {
  frameId: string,
  parentFrameId?: string
}

type TabSnapEnd = 'active' | 'closed' | 'navigated';

interface FrameNode {
  id: string,
  parent?: FrameNode,
  pageGraph?: string
}

interface TabSnapshot {
  url: string,
  end: TabSnapEnd,
  frames: Map<string, FrameNode>
}

interface TabTreeNode {
  parent?: TabTreeNode,
  parentSnapshot?: TabSnapshot,
  children?: TabTreeNode[],
  snapshots: TabSnapshot[]
}

interface TargetTrackerCloseFunc {
  (): Promise<void>
}

interface TargetTrackerDumpFunc {
  (outputPath: string): Promise<string>
}

interface TargetTracker {
  close: TargetTrackerCloseFunc,
  dump: TargetTrackerDumpFunc
}

interface TargetTrackerFactory {
  (page: any /* puppeteer Page */, logger: Logger): Promise<TargetTracker>
}

interface PageGraphTrackerWaitTrigger {
  (): void
}

interface PageGraphTrackerWaiter {
  trigger?: PageGraphTrackerWaitTrigger,
  promise?: Promise<void>,
}
