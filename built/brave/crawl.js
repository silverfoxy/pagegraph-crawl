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
import * as osLib from 'os';
import fsExtraLib from 'fs-extra';
import puppeteerLib from 'puppeteer-core';
import Xvbf from 'xvfb';
import { getLogger } from './debug.js';
import { puppeteerConfigForArgs } from './puppeteer.js';
const xvfbPlatforms = new Set(['linux', 'openbsd']);
const setupEnv = (args) => {
    const logger = getLogger(args);
    const platformName = osLib.platform();
    let closeFunc;
    if (args.interactive) {
        logger.debug('Interactive mode, skipping Xvfb');
        closeFunc = () => { };
    }
    else if (xvfbPlatforms.has(platformName)) {
        logger.debug(`Running on ${platformName}, starting Xvfb`);
        const xvfbHandle = new Xvbf();
        xvfbHandle.startSync();
        closeFunc = () => {
            logger.debug('Tearing down Xvfb');
            xvfbHandle.stopSync();
        };
    }
    else {
        logger.debug(`Running on ${platformName}, Xvfb not supported`);
        closeFunc = () => { };
    }
    return {
        close: closeFunc
    };
};
export const graphsForUrl = (args, url) => __awaiter(void 0, void 0, void 0, function* () {
    const logger = getLogger(args);
    const { puppeteerArgs, pathForProfile, shouldClean } = puppeteerConfigForArgs(args);
    const envHandle = setupEnv(args);
    let rawOutput;
    const clients = [];
    try {
        logger.debug('Launching puppeteer with args: ', puppeteerArgs);
        const browser = yield puppeteerLib.launch(puppeteerArgs);
        const page = yield browser.newPage();
        const tracker = yield args.trackerFactory(page, logger);
        if (args.userAgent) {
            yield page.setUserAgent(args.userAgent);
        }
        logger.debug(`Navigating to ${url}`);
        yield page.goto(url);
        const waitTimeMs = args.seconds * 1000;
        logger.debug(`Waiting for ${waitTimeMs}ms`);
        yield page.waitFor(waitTimeMs);
        try {
            yield tracker.close();
            rawOutput = yield tracker.dump(args.outputPath);
        }
        finally {
            logger.debug('Closing the browser');
            yield browser.close();
        }
    }
    finally {
        envHandle.close();
        if (shouldClean) {
            fsExtraLib.remove(pathForProfile);
        }
    }
    return rawOutput;
});
export const writeGraphsForCrawl = (args) => __awaiter(void 0, void 0, void 0, function* () {
    const logger = getLogger(args);
    const url = args.urls[0];
    const rawOutput = yield graphsForUrl(args, url);
    logger.debug(`Writing result to ${args.outputPath}`);
    yield fsExtraLib.writeFile(args.outputPath, rawOutput); // TODO: multiple-graphml-file-output
    return 1;
});
