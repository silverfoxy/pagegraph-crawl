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

const pushNewSnapshot = (node: TabTreeNode, target: any /* puppeteer Target */): TabSnapshot => {
    const snap: TabSnapshot = {
        url: target.url(),
        end: 'active'
    }
    node.snapshots.push(snap)
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

export const trackAllTargets = async (page: any /* puppeteer Page */, logger: Logger): Promise<TargetTracker> => {
    const browser: any /* puppeteer Browser */ = page.browser();

    const tabTreeRoots: TabTreeNode[] = [];
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
            pushNewSnapshot(node, target)

            const client = await target.createCDPSession()
            targetClientMap.set(target, client)
            client.on('Page.finalPageGraph', (params: PageFinalPageGraph) => {
                logger.debug(`got Page.finalPageGraph signal for ${target.url()} target (${params.data.length} chars)`)
                const snap = activeSnapshot(node)
                snap.end = 'navigated'
                // TODO: perhaps add in more context on what kind of navigation it was?
                snap.pageGraphML = params.data
            })
            await client.send('Page.enable')
        }
    }
    browser.on('targetcreated', wrapNewTarget)
    browser.on('targetchanged', (target: any /* puppeteer Target */) => {
        if (target.type() === 'page') {
            logger.debug('changed target', target.url())
            const node = lookupTarget(target, 'changed')
            if (node) {
                activeSnapshot(node).end = 'navigated'
                pushNewSnapshot(node, target)
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
                            const params: PageFinalPageGraph = await client.send('Page.generatePageGraph')
                            const snap = activeSnapshot(node)
                            snap.pageGraphML = params.data
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
                                logger.debug("ERROR getting PageGraph data", error)
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
            const snapMap = new Map<TabSnapshot, string>()
            const dumpFiles = (node: TabTreeNode, prefix: string): void => {
                node.snapshots.forEach((snap, i) => {
                    const filename = pathLib.join(outputDir, `${prefix}.${i}.graphml`)
                    logger.debug(`ready to write '${filename}' (${snap.pageGraphML ? snap.pageGraphML.length : "n/a"} chars)`)
                    if (snap.pageGraphML) {
                        fsLib.writeFileSync(filename, snap.pageGraphML)
                    }
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
            return 'TODO: standardize a JSON structure of the tab tree for later reference'
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
                    logger.debug("ERROR getting PageGraph data", error)
                    throw error
                }
            }
        },
        dump: async (_: string): Promise<string> => {
            if (finalPageGraph) {
                return finalPageGraph
            } else {
                throw Error("no PageGraph data available for sole tracked target")
            }
        }
    })
}

export const getTrackerFactoryForStrategy = (strategy: TrackerStrategy): TargetTrackerFactory => {
    return (strategy === 'multi') ? trackAllTargets : trackSingleTarget;
}