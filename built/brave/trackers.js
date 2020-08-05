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
        if (targetType === 'page') {
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
                yield pageCdp.send('Page.navigate', { url: 'about:blank' });
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
const targetInternals = (target /* puppeteer Target */) => {
    const { _targetId: targetId, _targetInfo: { type: targetType } } = target;
    return { targetId, targetType };
};
class PageGraphTracker {
    constructor(browser /* puppeteer Browser */, logger) {
        this._logger = logger;
        this._remoteFrames = new Map();
        this._buggedPages = new Map();
        this._pendingGraphs = new Map();
        this._emittedGraphs = [];
        browser.on('targetcreated', this._onTargetCreated.bind(this));
        browser.on('targetchanged', (target /* puppeteer Target */) => {
            const { targetId, targetType } = targetInternals(target);
            if (targetType === 'iframe') {
                this._logger.debug(`remote iframe ${targetId} changed: url=${target.url()}`);
            }
        });
        browser.on('targetdestroyed', this._onTargetDestroyed.bind(this));
    }
    get firstMainFrameId() {
        return this._firstMainFrameId || '';
    }
    shutdown() {
        return __awaiter(this, void 0, void 0, function* () {
            this._logger.debug(`shutting down ${this._remoteFrames.size} remote iframe(s)...`);
            yield Promise.all(Array.from(this._remoteFrames.entries()).reverse().map(([frameId, target]) => __awaiter(this, void 0, void 0, function* () {
                const waitPromise = this._waitForNext(frameId);
                try {
                    const client = yield target.createCDPSession();
                    yield client.send('Page.navigate', { url: 'about:blank' });
                    yield client.detach();
                    return waitPromise;
                }
                catch (error) {
                    console.error(error);
                }
            })));
            this._logger.debug(`shutting down ${this._buggedPages.size} page(s)...`);
            yield Promise.all(Array.from(this._buggedPages.keys()).map((target) => __awaiter(this, void 0, void 0, function* () {
                const { targetId } = targetInternals(target);
                const waitPromise = this._waitForNext(targetId);
                try {
                    const page = yield target.page();
                    yield page.goto('about:blank');
                    return waitPromise;
                }
                catch (error) {
                    console.error(error);
                }
            })));
            return this._emittedGraphs;
        });
    }
    _waitForNext(frameId) {
        const waiter = this._pendingGraphs.get(frameId) || {};
        if (!waiter.promise) {
            waiter.promise = new Promise(resolve => {
                waiter.trigger = resolve;
                this._pendingGraphs.set(frameId, waiter);
            });
        }
        return waiter.promise;
    }
    _onTargetCreated(target /* puppeteer Target */) {
        return __awaiter(this, void 0, void 0, function* () {
            const { targetId, targetType } = targetInternals(target);
            if (targetType === 'iframe') {
                this._logger.debug(`new remote iframe ${targetId}`);
                this._remoteFrames.set(targetId, target);
            }
            else if (targetType === 'page') {
                const page = yield target.page();
                page.on('frameattached', (frame /* puppeteer Frame */) => {
                    this._logger.debug(frame._id, frame._parentFrame && frame._parentFrame._id);
                });
                if (!this._firstMainFrameId) {
                    this._firstMainFrameId = page.mainFrame()._id;
                }
                const client = yield target.createCDPSession().catch((error) => console.error(error));
                client.on('Page.finalPageGraph', this._onFinalPageGraph.bind(this));
                this._buggedPages.set(target, client);
            }
        });
    }
    _onFinalPageGraph(event) {
        return __awaiter(this, void 0, void 0, function* () {
            this._logger.debug(`Page.finalPageGraph { frameId: ${event.frameId}}`);
            this._emittedGraphs.push(event);
            const waiter = this._pendingGraphs.get(event.frameId);
            if (waiter && waiter.trigger) {
                this._logger.debug(`triggering waiter on ${event.frameId}`);
                waiter.trigger();
                this._pendingGraphs.delete(event.frameId);
            }
        });
    }
    _onTargetDestroyed(target /* puppeteer Target */) {
        return __awaiter(this, void 0, void 0, function* () {
            const { targetId, targetType } = targetInternals(target);
            if (targetType === 'iframe') {
                this._logger.debug(`destroyed remote iframe ${targetId}`);
                this._remoteFrames.delete(targetId);
            }
            else if (targetType === 'page') {
                const client = this._buggedPages.get(target);
                this._buggedPages.delete(target);
                if (client) {
                    yield client.detach().catch((error) => console.error(error));
                }
            }
        });
    }
}
export const trackSingleTarget = (browser /* puppeteer Page */, logger) => __awaiter(void 0, void 0, void 0, function* () {
    //const tracker = new PageGraphTracker(browser, logger)
    let pageGraphEvents = [];
    const pageSet = new Set();
    browser.on('targetcreated', (target) => __awaiter(void 0, void 0, void 0, function* () {
        if (target.type() === "page") {
            const page = yield target.page();
            pageSet.add(page);
            const client = yield target.createCDPSession();
            client.on('Page.finalPageGraph', (event) => {
                logger.debug(`finalpageGraph { frameId: ${event.frameId}, size: ${event.data.length}}`);
                pageGraphEvents.push(event);
            });
        }
    }));
    browser.on('targetdestroyed', (target) => __awaiter(void 0, void 0, void 0, function* () {
        if (target.type() === "page") {
            try {
                const page = yield target.page();
                pageSet.delete(page);
            }
            catch (error) {
                console.error(`page disappeared during target destruction`);
            }
        }
    }));
    return Object.freeze({
        close: () => __awaiter(void 0, void 0, void 0, function* () {
            try {
                yield Promise.all(Array.from(pageSet.values()).map((page) => page.goto("about:blank")));
            }
            catch (error) {
                if (isSessionClosedError(error)) {
                    logger.debug('session dropped');
                    // EAT IT and carry on
                }
                else if (isNotHTMLPageGraphError(error)) {
                    logger.debug('Was not able to fetch PageGraph data from target');
                    // EAT IT and carry on
                }
                else {
                    logger.debug('ERROR getting PageGraph data', error);
                    throw error;
                }
            }
        }),
        dump: (outputPath) => __awaiter(void 0, void 0, void 0, function* () {
            const outputDir = pathLib.dirname(outputPath);
            yield Promise.all(pageGraphEvents.map((event) => {
                return new Promise(resolve => {
                    const filename = pathLib.join(outputDir, `page_graph_${event.frameId}.graphml`);
                    fsLib.writeFile(filename, event.data, resolve);
                });
            }));
            return JSON.stringify({
                firstMainFrame: "wat"
            });
        })
    });
});
export const getTrackerFactoryForStrategy = (strategy) => {
    return (strategy === 'multi') ? trackAllTargets : trackSingleTarget;
};
