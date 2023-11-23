"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyse = exports.saveAnalysisToCsv = void 0;
const analyse_1 = require("../../commands/analyse");
const saveAnalysisToCsv = async (_req, res) => {
    try {
        const folders = _req.body.folders || [];
        const options = {
            plugins: _req.body.options.plugins ?? [],
            results: _req.body.options.results ?? 'results',
            refresh: _req.body.options.refresh ?? false,
        };
        const cache = _req.body.cache || true;
        await (0, analyse_1.saveToCsv)(folders, {
            plugins: options.plugins,
            results: options.results,
            refresh: options.refresh,
        }, cache);
        res.status(200).json({ data: 'ok' });
    }
    catch (error) {
        res.status(500).send(`Error: ${error}`);
    }
};
exports.saveAnalysisToCsv = saveAnalysisToCsv;
const analyse = async (_req, res) => {
    try {
        const folders = _req.body.folders || [];
        const options = {
            plugins: _req.body.options.plugins ?? [],
            results: _req.body.options.results ?? 'results',
            refresh: _req.body.options.refresh ?? false,
        };
        const cache = _req.body.cache || true;
        await (0, analyse_1.analyseFilesToCache)(folders, {
            plugins: options.plugins,
            // not used in analyse, only in saveAnalysisToCsv
            results: options.results,
            refresh: options.refresh,
        }, cache);
        res.status(200).json({ data: 'ok' });
    }
    catch (error) {
        res.status(500).send(`Error: ${error}`);
    }
};
exports.analyse = analyse;
