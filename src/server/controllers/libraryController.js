"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLibraryById = exports.getAllLibraries = void 0;
const mongo_cache_1 = require("../../cache/mongo-cache");
const getAllLibraries = async (_req, res) => {
    try {
        mongo_cache_1.mongoCacheLibrary.load();
        const value = await mongo_cache_1.mongoCacheLibrary.getAll();
        res.status(200).json({ data: value });
    }
    catch (err) {
        console.error(`Error: ${err}`);
        res.status(500).send('Internal Server Error');
    }
};
exports.getAllLibraries = getAllLibraries;
const getLibraryById = async (_req, res) => {
    try {
        const id = _req.body.id;
        mongo_cache_1.mongoCacheLibrary.load();
        const value = await mongo_cache_1.mongoCacheLibrary.get(id);
        res.status(200).json({ data: value });
    }
    catch (err) {
        console.error(`Error: ${err}`);
        res.status(500).send('Internal Server Error');
    }
};
exports.getLibraryById = getLibraryById;
