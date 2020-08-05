'use strict'

import * as fsLib from 'fs'
import * as pathLib from 'path'

const newTreeNode = (openerNode: TabTreeNode | undefined): TabTreeNode => {
  const node: TabTreeNode = {
    parent: openerNode,
    parentSnapshot: openerNode ? activeSnapshot(openerNode) : undefined,
    snapshots: []
  }
  if (openerNode) {
    if (openerNode.children) {
      openerNode.children.push(node)
    } else {
      openerNode.children = [node]
    }
  }

  return node
}

const pushNewSnapshot = (node: TabTreeNode, page: any /* puppeteer Page */): TabSnapshot => {
  const snap: TabSnapshot = {
    url: page.url(),
    end: 'active',
    frames: new Map<string, FrameNode>()
  }
  node.snapshots.push(snap)

  for (const initialFrame of page.frames()) {
    snap.frames.set(initialFrame._id, { id: initialFrame._id })
  }

  for (const fixupFrame of page.frames()) {
    const thisFrame = snap.frames.get(fixupFrame._id)
    if (fixupFrame._parentFrame) {
      const parentFrame = snap.frames.get(fixupFrame._parentFrame._id)
      if (thisFrame) {
        thisFrame.parent = parentFrame
      }
    }
  }

  return snap
}

const activeSnapshot = (node: TabTreeNode): TabSnapshot => {
  return node.snapshots[node.snapshots.length - 1]
}

const isNotHTMLPageGraphError = (error: Error): boolean => {
  return error.message.indexOf('No Page Graph for this Document') >= 0
}

const isSessionClosedError = (error: Error): boolean => {
  return error.message.indexOf('Session closed. Most likely the page has been closed.') >= 0
}

export const trackAllTargetsNew = async (browser: any /* puppeteer Browser */, logger: Logger): Promise<TargetTracker> => {
  const sessionSet = new WeakSet()
  const pageSet = new Set()
  const instrumentSession = async (cdp: any /* puppeteer CDPSession */) => {
    const sessionId = cdp._sessionId
    const targetType = cdp._targetType
    if (sessionSet.has(cdp)) {
      console.log('old session', sessionId, targetType)
      return
    }
    console.log('new session', sessionId, targetType)
    if (targetType === 'page') {
      pageSet.add(cdp)
    }

    if (['page', 'iframe'].includes(targetType)) {
      cdp.on('Page.finalPageGraph', async (params: PageFinalPageGraph) => {
        logger.debug(`Page.finalPageGraph { frameId: ${params.frameId}, data: ${params.data.length} chars of graphML }`)
      })
      cdp.on('Page.frameAttached', async (params: any) => {
        logger.debug('FRAME ATTACHED:', params)
      })
      await cdp.send('Page.enable')
    }
    cdp.on('Target.attachedToTarget', async (params: any) => {
      const { sessionId, targetInfo } = params
      console.log('COLLECTOR-DEBUG: Target.attachedToTarget:', sessionId, targetInfo.type, targetInfo.targetId)
      const cdp = browser._connection._sessions.get(sessionId)
      await instrumentSession(cdp)
    })
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    })
    console.log(`DONE INSTRUMENTING SESSION ${sessionId}`)
  }

  const rootSession = await browser.target().createCDPSession()
  await instrumentSession(rootSession)

  return Object.freeze({
    close: async () => {
      await Promise.all(Array.from(pageSet.values()).map(async (pageCdp: any /* puppeteer CDPSession */) => {
        await pageCdp.send('Page.navigate', { url: 'about:blank' })
      }))
    },
    dump: async () => {
      return ''
    }
  })
}

export const trackAllTargets = async (browser: any /* puppeteer Browser */, logger: Logger): Promise<TargetTracker> => {
  const tabTreeRoots: TabTreeNode[] = []
  const targetLookupMap = new Map<any /* puppeteer Target */, TabTreeNode>()
  const lookupTarget = (target: any /* puppeteer Target */, mode: string): TabTreeNode | undefined => {
    const node = targetLookupMap.get(target)
    if (node === undefined) {
      logger.debug(`unable to lookup ${mode} target:`, target)
    }
    return node
  }

  const targetClientMap = new WeakMap<any /* puppeteer Target */, any /* puppeteer CDPSession */>()
  const wrapNewTarget = async (target: any /* puppeteer Target */) => {
    if (target.type() === 'page') {
      logger.debug('new target', target.url())
      let openerNode
      if (target.opener() !== null) {
        openerNode = lookupTarget(target.opener(), 'created')
      }
      const node = newTreeNode(openerNode)
      targetLookupMap.set(target, node)

      if (!node.parent) {
        tabTreeRoots.push(node)
      }
      const page = await target.page()
      pushNewSnapshot(node, page)

      const client = await target.createCDPSession()
      targetClientMap.set(target, client)
      client.on('Page.finalPageGraph', (params: PageFinalPageGraph) => {
        logger.debug(`got Page.finalPageGraph signal for ${target.url()} target (${params.data.length} chars)`)
        const snap = activeSnapshot(node)
        const frame = snap.frames.get(params.frameId)
        if (frame) {
          frame.pageGraph = params.data // TODO: what about frame navigations? multiple PGs?
        } else {
          logger.debug(`ERROR: got finalPageGraph for unknown frame ${params.frameId}! ignoring...`)
        }
      })
      client.on('Page.frameAttached', async (params: PageFrameAttached) => {
        const snap = activeSnapshot(node)
        const frame: FrameNode = { id: params.frameId }

        if (params.parentFrameId) {
          frame.parent = snap.frames.get(params.parentFrameId)
        }

        snap.frames.set(frame.id, frame)
        logger.debug('FRAME:', frame)
      })
      await client.send('Page.enable')
    }
  }
  browser.on('targetcreated', wrapNewTarget)
  browser.on('targetchanged', async (target: any /* puppeteer Target */) => {
    if (target.type() === 'page') {
      logger.debug('changed target', target.url())
      const node = lookupTarget(target, 'changed')
      if (node) {
        activeSnapshot(node).end = 'navigated'
        const page = await target.page()
        pushNewSnapshot(node, page)
      }
    }
  })
  browser.on('targetdestroyed', (target: any /* puppeteer Target */) => {
    if (target.type() === 'page') {
      logger.debug('destroyed target', target.url())
      const node = lookupTarget(target, 'destroyed')
      if (node) {
        activeSnapshot(node).end = 'closed'
      }
      targetLookupMap.delete(target)
    }
  })

  for (const existingTarget of browser.targets()) {
    await wrapNewTarget(existingTarget)
  }

  return Object.freeze({
    close: async () => {
      await Promise.all(Array.from(targetLookupMap.entries()).map(async ([target, node]) => {
        try {
          const client = targetClientMap.get(target)
          if (client) {
            try {
              // navigate each page to "about:blank" to force destruction/notification for all PGs in that tab
              await client.send('Page.navigate', { url: 'about:blank' })
              const snap = activeSnapshot(node)
              snap.end = 'closed'
            } catch (error) {
              const currentUrl = target.url()
              if (isSessionClosedError(error)) {
                logger.debug(`session to target for ${currentUrl} dropped`)
                // EAT IT and carry on
              } else if (isNotHTMLPageGraphError(error)) {
                logger.debug(`Was not able to fetch PageGraph data from target for ${currentUrl}`)
                // EAT IT and carry on
              } else {
                logger.debug('ERROR getting PageGraph data', error)
                throw error
              }
            }
          } else {
            logger.debug('unable to lookup CDPSession for target:', target)
          }
          const page = await target.page()
          if (page) {
            await page.close()
          }
        } catch (err) {
          logger.debug('error closing target:', target)
          logger.debug(err)
        }
      }))
    },
    dump: async (outputPath: string) => {
      const outputDir = pathLib.dirname(outputPath)
      const dumpFiles = (node: TabTreeNode, prefix: string): void => {
        node.snapshots.forEach((snap, i) => {
          snap.frames.forEach((frame) => {
            const frameId = frame.id // frame.parent ? frame.id : "root"
            const filename = pathLib.join(outputDir, `${prefix}.${i}.${frameId}.graphml`)
            logger.debug(`ready to write '${filename}' (${frame.pageGraph ? frame.pageGraph.length : 'n/a'} chars)`)
            if (frame.pageGraph) {
              fsLib.writeFileSync(filename, frame.pageGraph)
            }
          })
        })
        node.children && node.children.forEach((kid, i) => {
          let nextPrefix = prefix
          if (kid.parentSnapshot) {
            const snapIndex = node.snapshots.indexOf(kid.parentSnapshot)
            nextPrefix += `.${snapIndex}`
          }
          dumpFiles(kid, `${nextPrefix}-${i}`)
        })
      }
      tabTreeRoots.forEach((root, i) => {
        dumpFiles(root, `t${i}`)
      })
      return JSON.stringify(Array.from(tabTreeRoots.entries()))
    }
  })
}

const targetInternals = (target: any /* puppeteer Target */) => {
  const {
    _targetId: targetId,
    _targetInfo: {
      type: targetType
    }
  } = target
  return { targetId, targetType }
}

class PageGraphTracker {
  _logger: Logger
  _remoteFrames: Map<string, any>
  _buggedPages: Map<any, any>
  _pendingGraphs: Map<string, PageGraphTrackerWaiter>
  _emittedGraphs: PageFinalPageGraph[]
  _firstMainFrameId: string | undefined

  constructor (browser: any /* puppeteer Browser */, logger: Logger) {
    this._logger = logger
    this._remoteFrames = new Map()
    this._buggedPages = new Map()
    this._pendingGraphs = new Map()
    this._emittedGraphs = []

    browser.on('targetcreated', this._onTargetCreated.bind(this))
    browser.on('targetchanged', (target: any /* puppeteer Target */) => {
      const { targetId, targetType } = targetInternals(target)
      if (targetType === 'iframe') {
        this._logger.debug(`remote iframe ${targetId} changed: url=${target.url()}`)
      }
    })
    browser.on('targetdestroyed', this._onTargetDestroyed.bind(this))
  }

  get firstMainFrameId (): string {
    return this._firstMainFrameId || ''
  }

  async shutdown () {
    this._logger.debug(`shutting down ${this._remoteFrames.size} remote iframe(s)...`)
    await Promise.all(Array.from(this._remoteFrames.entries()).reverse().map(async ([frameId, target]) => {
      const waitPromise = this._waitForNext(frameId)
      try {
        const client = await target.createCDPSession()
        await client.send('Page.navigate', { url: 'about:blank' })
        await client.detach()
        return waitPromise
      } catch (error) {
        console.error(error)
      }
    }))

    this._logger.debug(`shutting down ${this._buggedPages.size} page(s)...`)
    await Promise.all(Array.from(this._buggedPages.keys()).map(async target => {
      const { targetId } = targetInternals(target)
      const waitPromise = this._waitForNext(targetId)
      try {
        const page = await target.page()
        await page.goto('about:blank')
        return waitPromise
      } catch (error) {
        console.error(error)
      }
    }))

    return this._emittedGraphs
  }

  _waitForNext (frameId: string): Promise<void> {
    const waiter = this._pendingGraphs.get(frameId) || {}
    if (!waiter.promise) {
      waiter.promise = new Promise(resolve => {
        waiter.trigger = resolve
        this._pendingGraphs.set(frameId, waiter)
      })
    }
    return waiter.promise
  }

  async _onTargetCreated (target: any /* puppeteer Target */) {
    const { targetId, targetType } = targetInternals(target)
    if (targetType === 'iframe') {
      this._logger.debug(`new remote iframe ${targetId}`)
      this._remoteFrames.set(targetId, target)
    } else if (targetType === 'page') {
      const page = await target.page()
      page.on('frameattached', (frame: any /* puppeteer Frame */) => {
        this._logger.debug(frame._id, frame._parentFrame && frame._parentFrame._id)
      })

      if (!this._firstMainFrameId) {
        this._firstMainFrameId = page.mainFrame()._id
      }

      const client = await target.createCDPSession().catch((error: Error) => console.error(error))
      client.on('Page.finalPageGraph', this._onFinalPageGraph.bind(this))
      this._buggedPages.set(target, client)
    }
  }

  async _onFinalPageGraph (event: PageFinalPageGraph) {
    this._logger.debug(`Page.finalPageGraph { frameId: ${event.frameId}}`)
    this._emittedGraphs.push(event)

    const waiter = this._pendingGraphs.get(event.frameId)
    if (waiter && waiter.trigger) {
      this._logger.debug(`triggering waiter on ${event.frameId}`)
      waiter.trigger()
      this._pendingGraphs.delete(event.frameId)
    }
  }

  async _onTargetDestroyed (target: any /* puppeteer Target */) {
    const { targetId, targetType } = targetInternals(target)
    if (targetType === 'iframe') {
      this._logger.debug(`destroyed remote iframe ${targetId}`)
      this._remoteFrames.delete(targetId)
    } else if (targetType === 'page') {
      const client = this._buggedPages.get(target)
      this._buggedPages.delete(target)
      if (client) {
        await client.detach().catch((error: Error) => console.error(error))
      }
    }
  }
}

export const trackSingleTarget = async (browser: any /* puppeteer Page */, logger: Logger): Promise<TargetTracker> => {
  //const tracker = new PageGraphTracker(browser, logger)
  let pageGraphEvents: PageFinalPageGraph[] = []

  const pageSet = new Set()
  browser.on('targetcreated', async (target: any) => {
    if (target.type() === "page") {
      const page = await target.page()
      pageSet.add(page)

      const client = await target.createCDPSession()
      client.on('Page.finalPageGraph', (event: PageFinalPageGraph) => {
        logger.debug(`finalpageGraph { frameId: ${event.frameId}, size: ${event.data.length}}`)
        pageGraphEvents.push(event)
      })
    }
  })
  browser.on('targetdestroyed', async (target: any) => {
    if (target.type() === "page") {
      try {
        const page = await target.page()
        pageSet.delete(page)
      } catch (error) {
        console.error(`page disappeared during target destruction`)
      }
    }
  })

  return Object.freeze({
    close: async (): Promise<void> => {
      try {
        await Promise.all(Array.from(pageSet.values()).map((page: any) => page.goto("about:blank")))
      } catch (error) {
        if (isSessionClosedError(error)) {
          logger.debug('session dropped')
          // EAT IT and carry on
        } else if (isNotHTMLPageGraphError(error)) {
          logger.debug('Was not able to fetch PageGraph data from target')
          // EAT IT and carry on
        } else {
          logger.debug('ERROR getting PageGraph data', error)
          throw error
        }
      }
    },
    dump: async (outputPath: string): Promise<string> => {
      const outputDir = pathLib.dirname(outputPath)
      await Promise.all(pageGraphEvents.map((event: PageFinalPageGraph) => {
        return new Promise(resolve => {
          const filename = pathLib.join(outputDir, `page_graph_${event.frameId}.graphml`)
          fsLib.writeFile(filename, event.data, resolve)
        })
      }))
      return JSON.stringify({
        firstMainFrame: "wat"
      })
    }
  })
}

export const getTrackerFactoryForStrategy = (strategy: TrackerStrategy): TargetTrackerFactory => {
  return (strategy === 'multi') ? trackAllTargets : trackSingleTarget
}
