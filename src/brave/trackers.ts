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
    if (targetType === "page") {
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
        await pageCdp.send('Page.navigate', { url: "about:blank" })
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

export const trackSingleTarget = async (page: any /* puppeteer Page */, logger: Logger): Promise<TargetTracker> => {
  const target = page.target()
  const client = await target.createCDPSession()
  let finalPageGraph: string | undefined

  return Object.freeze({
    close: async (): Promise<void> => {
      try {
        const params: PageFinalPageGraph = await client.send('Page.generatePageGraph')
        finalPageGraph = params.data
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
    },
    dump: async (): Promise<string> => {
      if (finalPageGraph) {
        return finalPageGraph
      } else {
        throw Error('no PageGraph data available for sole tracked target')
      }
    }
  })
}

export const getTrackerFactoryForStrategy = (strategy: TrackerStrategy): TargetTrackerFactory => {
  return (strategy === 'multi') ? trackAllTargets : trackSingleTarget
}
