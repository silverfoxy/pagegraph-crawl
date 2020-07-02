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
const pushNewSnapshot = (node, target /* puppeteer Target */) => {
    const snap = {
        url: target.url(),
        end: 'active'
    };
    node.snapshots.push(snap);
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
export const trackAllTargets = (page /* puppeteer Page */, logger) => __awaiter(void 0, void 0, void 0, function* () {
    const browser = page.browser();
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
            pushNewSnapshot(node, target);
            const client = yield target.createCDPSession();
            targetClientMap.set(target, client);
            client.on('Page.finalPageGraph', (params) => {
                logger.debug(`got Page.finalPageGraph signal for ${target.url()} target (${params.data.length} chars)`);
                const snap = activeSnapshot(node);
                snap.end = 'navigated';
                // TODO: perhaps add in more context on what kind of navigation it was?
                snap.pageGraphML = params.data;
            });
            yield client.send('Page.enable');
        }
    });
    browser.on('targetcreated', wrapNewTarget);
    browser.on('targetchanged', (target /* puppeteer Target */) => {
        if (target.type() === 'page') {
            logger.debug('changed target', target.url());
            const node = lookupTarget(target, 'changed');
            if (node) {
                activeSnapshot(node).end = 'navigated';
                pushNewSnapshot(node, target);
            }
        }
    });
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
                            const params = yield client.send('Page.generatePageGraph');
                            const snap = activeSnapshot(node);
                            snap.pageGraphML = params.data;
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
                                logger.debug("ERROR getting PageGraph data", error);
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
            const snapMap = new Map();
            const dumpFiles = (node, prefix) => {
                node.snapshots.forEach((snap, i) => {
                    const filename = pathLib.join(outputDir, `${prefix}.${i}.graphml`);
                    logger.debug(`ready to write '${filename}' (${snap.pageGraphML ? snap.pageGraphML.length : "n/a"} chars)`);
                    if (snap.pageGraphML) {
                        fsLib.writeFileSync(filename, snap.pageGraphML);
                    }
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
            return 'TODO: standardize a JSON structure of the tab tree for later reference';
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
                    logger.debug("ERROR getting PageGraph data", error);
                    throw error;
                }
            }
        }),
        dump: (_) => __awaiter(void 0, void 0, void 0, function* () {
            if (finalPageGraph) {
                return finalPageGraph;
            }
            else {
                throw Error("no PageGraph data available for sole tracked target");
            }
        })
    });
});
export const getTrackerFactoryForStrategy = (strategy) => {
    return (strategy === 'multi') ? trackAllTargets : trackSingleTarget;
};
