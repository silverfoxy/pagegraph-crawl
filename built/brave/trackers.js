'use strict';
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import * as fsLib from 'fs';
import * as pathLib from 'path';
const newTreeNode = (openerNode) => {
    const node = {
        parent: openerNode,
        parentSnapshot: openerNode ? activeSnapshot(openerNode) : undefined,
        snapshots: []
    };
    if (openerNode) {
        if (openerNode.children) {
            openerNode.children.push(node);
        }
        else {
            openerNode.children = [node];
        }
    }
    return node;
};
const pushNewSnapshot = (node, page /* puppeteer Page */) => {
    const snap = {
        url: page.url(),
        end: 'active',
        frames: new Map()
    };
    node.snapshots.push(snap);
    for (const initialFrame of page.frames()) {
        snap.frames.set(initialFrame._id, { id: initialFrame._id });
    }
    for (const fixupFrame of page.frames()) {
        const thisFrame = snap.frames.get(fixupFrame._id);
        if (fixupFrame._parentFrame) {
            const parentFrame = snap.frames.get(fixupFrame._parentFrame._id);
            if (thisFrame) {
                thisFrame.parent = parentFrame;
            }
        }
    }
    return snap;
};
const activeSnapshot = (node) => {
    return node.snapshots[node.snapshots.length - 1];
};
const isNotHTMLPageGraphError = (error) => {
    return error.message.indexOf('No Page Graph for this Document') >= 0;
};
const isSessionClosedError = (error) => {
    return error.message.indexOf('Session closed. Most likely the page has been closed.') >= 0;
};
export const trackAllTargetsNew = (browser /* puppeteer Browser */, logger) => __awaiter(void 0, void 0, void 0, function* () {
    const sessionSet = new WeakSet();
    const pageSet = new Set();
    const instrumentSession = (cdp /* puppeteer CDPSession */) => __awaiter(void 0, void 0, void 0, function* () {
        const sessionId = cdp._sessionId;
        const targetType = cdp._targetType;
        if (sessionSet.has(cdp)) {
            console.log('old session', sessionId, targetType);
            return;
        }
        console.log('new session', sessionId, targetType);
        if (targetType === "page") {
            pageSet.add(cdp);
        }
        if (['page', 'iframe'].includes(targetType)) {
            cdp.on('Page.finalPageGraph', (params) => __awaiter(void 0, void 0, void 0, function* () {
                logger.debug(`Page.finalPageGraph { frameId: ${params.frameId}, data: ${params.data.length} chars of graphML }`);
            }));
            cdp.on('Page.frameAttached', (params) => __awaiter(void 0, void 0, void 0, function* () {
                logger.debug('FRAME ATTACHED:', params);
            }));
            yield cdp.send('Page.enable');
        }
        cdp.on('Target.attachedToTarget', (params) => __awaiter(void 0, void 0, void 0, function* () {
            const { sessionId, targetInfo } = params;
            console.log('COLLECTOR-DEBUG: Target.attachedToTarget:', sessionId, targetInfo.type, targetInfo.targetId);
            const cdp = browser._connection._sessions.get(sessionId);
            yield instrumentSession(cdp);
        }));
        yield cdp.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true
        });
        console.log(`DONE INSTRUMENTING SESSION ${sessionId}`);
    });
    const rootSession = yield browser.target().createCDPSession();
    yield instrumentSession(rootSession);
    return Object.freeze({
        close: () => __awaiter(void 0, void 0, void 0, function* () {
            yield Promise.all(Array.from(pageSet.values()).map((pageCdp /* puppeteer CDPSession */) => __awaiter(void 0, void 0, void 0, function* () {
                yield pageCdp.send('Page.navigate', { url: "about:blank" });
            })));
        }),
        dump: () => __awaiter(void 0, void 0, void 0, function* () {
            return '';
        })
    });
});
export const trackAllTargets = (browser /* puppeteer Browser */, logger) => __awaiter(void 0, void 0, void 0, function* () {
    const tabTreeRoots = [];
    const targetLookupMap = new Map();
    const lookupTarget = (target /* puppeteer Target */, mode) => {
        const node = targetLookupMap.get(target);
        if (node === undefined) {
            logger.debug(`unable to lookup ${mode} target:`, target);
        }
        return node;
    };
    const targetClientMap = new WeakMap();
    const wrapNewTarget = (target /* puppeteer Target */) => __awaiter(void 0, void 0, void 0, function* () {
        if (target.type() === 'page') {
            logger.debug('new target', target.url());
            let openerNode;
            if (target.opener() !== null) {
                openerNode = lookupTarget(target.opener(), 'created');
            }
            const node = newTreeNode(openerNode);
            targetLookupMap.set(target, node);
            if (!node.parent) {
                tabTreeRoots.push(node);
            }
            const page = yield target.page();
            pushNewSnapshot(node, page);
            const client = yield target.createCDPSession();
            targetClientMap.set(target, client);
            client.on('Page.finalPageGraph', (params) => {
                logger.debug(`got Page.finalPageGraph signal for ${target.url()} target (${params.data.length} chars)`);
                const snap = activeSnapshot(node);
                const frame = snap.frames.get(params.frameId);
                if (frame) {
                    frame.pageGraph = params.data; // TODO: what about frame navigations? multiple PGs?
                }
                else {
                    logger.debug(`ERROR: got finalPageGraph for unknown frame ${params.frameId}! ignoring...`);
                }
            });
            client.on('Page.frameAttached', (params) => __awaiter(void 0, void 0, void 0, function* () {
                const snap = activeSnapshot(node);
                const frame = { id: params.frameId };
                if (params.parentFrameId) {
                    frame.parent = snap.frames.get(params.parentFrameId);
                }
                snap.frames.set(frame.id, frame);
                logger.debug('FRAME:', frame);
            }));
            yield client.send('Page.enable');
        }
    });
    browser.on('targetcreated', wrapNewTarget);
    browser.on('targetchanged', (target /* puppeteer Target */) => __awaiter(void 0, void 0, void 0, function* () {
        if (target.type() === 'page') {
            logger.debug('changed target', target.url());
            const node = lookupTarget(target, 'changed');
            if (node) {
                activeSnapshot(node).end = 'navigated';
                const page = yield target.page();
                pushNewSnapshot(node, page);
            }
        }
    }));
    browser.on('targetdestroyed', (target /* puppeteer Target */) => {
        if (target.type() === 'page') {
            logger.debug('destroyed target', target.url());
            const node = lookupTarget(target, 'destroyed');
            if (node) {
                activeSnapshot(node).end = 'closed';
            }
            targetLookupMap.delete(target);
        }
    });
    for (const existingTarget of browser.targets()) {
        yield wrapNewTarget(existingTarget);
    }
    return Object.freeze({
        close: () => __awaiter(void 0, void 0, void 0, function* () {
            yield Promise.all(Array.from(targetLookupMap.entries()).map(([target, node]) => __awaiter(void 0, void 0, void 0, function* () {
                try {
                    const client = targetClientMap.get(target);
                    if (client) {
                        try {
                            // navigate each page to "about:blank" to force destruction/notification for all PGs in that tab
                            yield client.send('Page.navigate', { url: 'about:blank' });
                            const snap = activeSnapshot(node);
                            snap.end = 'closed';
                        }
                        catch (error) {
                            const currentUrl = target.url();
                            if (isSessionClosedError(error)) {
                                logger.debug(`session to target for ${currentUrl} dropped`);
                                // EAT IT and carry on
                            }
                            else if (isNotHTMLPageGraphError(error)) {
                                logger.debug(`Was not able to fetch PageGraph data from target for ${currentUrl}`);
                                // EAT IT and carry on
                            }
                            else {
                                logger.debug('ERROR getting PageGraph data', error);
                                throw error;
                            }
                        }
                    }
                    else {
                        logger.debug('unable to lookup CDPSession for target:', target);
                    }
                    const page = yield target.page();
                    if (page) {
                        yield page.close();
                    }
                }
                catch (err) {
                    logger.debug('error closing target:', target);
                    logger.debug(err);
                }
            })));
        }),
        dump: (outputPath) => __awaiter(void 0, void 0, void 0, function* () {
            const outputDir = pathLib.dirname(outputPath);
            const dumpFiles = (node, prefix) => {
                node.snapshots.forEach((snap, i) => {
                    snap.frames.forEach((frame) => {
                        const frameId = frame.id; // frame.parent ? frame.id : "root"
                        const filename = pathLib.join(outputDir, `${prefix}.${i}.${frameId}.graphml`);
                        logger.debug(`ready to write '${filename}' (${frame.pageGraph ? frame.pageGraph.length : 'n/a'} chars)`);
                        if (frame.pageGraph) {
                            fsLib.writeFileSync(filename, frame.pageGraph);
                        }
                    });
                });
                node.children && node.children.forEach((kid, i) => {
                    let nextPrefix = prefix;
                    if (kid.parentSnapshot) {
                        const snapIndex = node.snapshots.indexOf(kid.parentSnapshot);
                        nextPrefix += `.${snapIndex}`;
                    }
                    dumpFiles(kid, `${nextPrefix}-${i}`);
                });
            };
            tabTreeRoots.forEach((root, i) => {
                dumpFiles(root, `t${i}`);
            });
            return JSON.stringify(Array.from(tabTreeRoots.entries()));
        })
    });
});
export const trackSingleTarget = (page /* puppeteer Page */, logger) => __awaiter(void 0, void 0, void 0, function* () {
    const target = page.target();
    const client = yield target.createCDPSession();
    let finalPageGraph;
    return Object.freeze({
        close: () => __awaiter(void 0, void 0, void 0, function* () {
            try {
                const params = yield client.send('Page.generatePageGraph');
                finalPageGraph = params.data;
            }
            catch (error) {
                const currentUrl = target.url();
                if (isSessionClosedError(error)) {
                    logger.debug(`session to target for ${currentUrl} dropped`);
                    // EAT IT and carry on
                }
                else if (isNotHTMLPageGraphError(error)) {
                    logger.debug(`Was not able to fetch PageGraph data from target for ${currentUrl}`);
                    // EAT IT and carry on
                }
                else {
                    logger.debug('ERROR getting PageGraph data', error);
                    throw error;
                }
            }
        }),
        dump: () => __awaiter(void 0, void 0, void 0, function* () {
            if (finalPageGraph) {
                return finalPageGraph;
            }
            else {
                throw Error('no PageGraph data available for sole tracked target');
            }
        })
    });
});
export const getTrackerFactoryForStrategy = (strategy) => {
    return (strategy === 'multi') ? trackAllTargets : trackSingleTarget;
};
